import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Arch, build, Platform, type Configuration } from 'electron-builder';
import { z } from 'zod';
import { APP_ID, APP_NAME, archiveNames, fileChecksum, previewMode, readReleaseMetadata, verifyReleaseFiles } from './release-metadata.ts';

const execute = promisify(execFile);
export const signingVariables = ['APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'CSC_KEYCHAIN'] as const;

export function buildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean = { ...env };
	for (const name of [...signingVariables, 'GH_TOKEN', 'GITHUB_TOKEN', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'BUILD_CERTIFICATE_BASE64', 'P12_PASSWORD']) {
		delete clean[name];
	}
	return clean;
}

export function requireSigningEnvironment(env: NodeJS.ProcessEnv): { teamId: string; keychain: string } {
	for (const name of signingVariables) {
		if (!env[name]?.trim()) {
			throw new Error(`Missing ${name}; a signed release never falls back to an unsigned build.`);
		}
	}
	const teamId = env.APPLE_TEAM_ID!;
	if (!/^[A-Z\d]{10}$/.test(teamId)) {
		throw new Error('APPLE_TEAM_ID must be ten uppercase letters or digits.');
	}
	return { teamId, keychain: env.CSC_KEYCHAIN! };
}

export function builderIdentity(identity: string | null): string | null {
	// electron-builder selects the certificate type itself; codesign still needs the full identity.
	return identity?.replace(/^Developer ID Application: /, '') ?? null;
}

export async function releaseCommand(tool: string, arguments_: string[], env = process.env): Promise<{ stdout: string; stderr: string }> {
	try {
		return await execute(tool, arguments_, { env, maxBuffer: 32 * 1024 * 1024, timeout: 45 * 60 * 1000 });
	} catch {
		// Signing and notarization arguments can contain credentials.
		throw new Error(`${tool} failed during release verification. Command arguments and output were withheld.`);
	}
}

async function runBuild(arguments_: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, arguments_, { env: buildEnvironment(process.env), shell: false, stdio: 'inherit' });
		child.once('error', () => reject(new Error('Release build process could not start.')));
		child.once('close', (code) => (code === 0 ? resolve() : reject(new Error('Release build process failed.'))));
	});
}

async function plistValue(app: string, key: string): Promise<string> {
	return (await releaseCommand('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, join(app, 'Contents/Info.plist')])).stdout.trim();
}

async function verifySignature(path: string, teamId: string, runtime = false): Promise<void> {
	const { stderr } = await releaseCommand('/usr/bin/codesign', ['--display', '--verbose=4', path]);
	if (!stderr.includes(`TeamIdentifier=${teamId}`) || !stderr.includes('Authority=Developer ID Application:') || (runtime && !/flags=.*\(runtime\)/.test(stderr))) {
		throw new Error('Binary does not have the required Developer ID, team and Hardened Runtime signature.');
	}
	await releaseCommand('/usr/bin/codesign', ['--verify', '--strict', path]);
}

export async function verifyMacApp(app: string, version: string, teamId?: string): Promise<void> {
	for (const [key, expected] of [
		['CFBundleIdentifier', APP_ID],
		['CFBundleShortVersionString', version],
		['CFBundleVersion', version],
	]) {
		if ((await plistValue(app, key)) !== expected) {
			throw new Error(`Unexpected application ${key}.`);
		}
	}
	const executable = join(app, 'Contents/MacOS', APP_NAME);
	if ((await releaseCommand('/usr/bin/lipo', ['-archs', executable])).stdout.trim() !== 'arm64') {
		throw new Error('Distribution requires an arm64 application.');
	}
	const icon = join(app, 'Contents/Resources', await plistValue(app, 'CFBundleIconFile'));
	const bytes = await readFile(icon);
	if (bytes.toString('ascii', 0, 4) !== 'icns' || bytes.readUInt32BE(4) !== bytes.length) {
		throw new Error('Application icon is invalid.');
	}
	await readFile(join(app, 'Contents/Resources/Assets.car'));
	const runtime = join(app, 'Contents/Resources/svn');
	const manifest = z
		.object({ version: z.string(), arch: z.literal('arm64'), platform: z.literal('darwin') })
		.parse(JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8')));
	const svn = join(runtime, 'bin/svn');
	if ((await releaseCommand(svn, ['--version', '--quiet'], buildEnvironment(process.env))).stdout.trim() !== manifest.version) {
		throw new Error('Bundled SVN version does not match its manifest.');
	}
	const nativeFiles = [svn, ...(await readdir(join(runtime, 'lib'))).map((name) => join(runtime, 'lib', name))];
	for (const path of nativeFiles) {
		if ((await releaseCommand('/usr/bin/lipo', ['-archs', path])).stdout.trim() !== 'arm64') {
			throw new Error('Bundled SVN contains an incompatible architecture.');
		}
		const dependencies = (await releaseCommand('/usr/bin/otool', ['-L', path])).stdout
			.split('\n')
			.slice(1)
			.filter((line) => line.trim());
		if (dependencies.some((line) => !/^\s*(\/usr\/lib\/|\/System\/Library\/|@loader_path\/|@executable_path\/)/.test(line))) {
			throw new Error('Bundled SVN depends on a development-machine library.');
		}
		if (teamId) {
			await verifySignature(path, teamId, true);
		}
	}
	if (teamId) {
		await verifySignature(app, teamId, true);
		await releaseCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
		await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', app]);
		await releaseCommand('/usr/sbin/spctl', ['--assess', '--verbose=2', '--type', 'execute', app]);
	}
}

async function notarize(path: string, keychain: string): Promise<void> {
	const { stdout } = await releaseCommand('/usr/bin/xcrun', [
		'notarytool',
		'submit',
		path,
		'--keychain-profile',
		'svnbox-notary',
		'--keychain',
		keychain,
		'--wait',
		'--output-format',
		'json',
	]);
	if (z.object({ status: z.string() }).parse(JSON.parse(stdout)).status !== 'Accepted') {
		throw new Error('Apple notarization was not accepted.');
	}
}

async function main(): Promise<void> {
	if (process.platform !== 'darwin' || process.arch !== 'arm64') {
		throw new Error('Release builds require macOS arm64.');
	}
	const unsigned = previewMode(process.argv.slice(2), process.env);
	const metadata = await readReleaseMetadata(process.cwd(), process.env.GITHUB_REF_TYPE === 'tag' ? (process.env.GITHUB_REF_NAME ?? '') : undefined, unsigned);
	const signing = unsigned ? undefined : requireSigningEnvironment(process.env);
	let identity: string | null = null;
	if (signing) {
		const { stdout } = await releaseCommand('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', signing.keychain]);
		identity = stdout.match(new RegExp(`"(Developer ID Application: [^"\\r\\n]+ \\(${signing.teamId}\\))"`))?.[1] ?? null;
		if (!identity) {
			throw new Error('The temporary keychain has no Developer ID Application identity for this team.');
		}
		await releaseCommand('/usr/bin/xcrun', [
			'notarytool',
			'store-credentials',
			'svnbox-notary',
			'--apple-id',
			process.env.APPLE_ID!,
			'--team-id',
			signing.teamId,
			'--password',
			process.env.APPLE_APP_SPECIFIC_PASSWORD!,
			'--keychain',
			signing.keychain,
		]);
	}
	for (const script of ['scripts/build-svn-runtime.mjs', 'scripts/build-icons.mjs', 'scripts/build-themes.mjs']) {
		await runBuild([script]);
	}
	await runBuild(['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json']);
	await runBuild(['node_modules/electron-vite/bin/electron-vite.js', 'build']);
	const stageRoot = resolve('.cache/release-staging');
	await mkdir(stageRoot, { recursive: true });
	const stage = await mkdtemp(join(stageRoot, 'run-'));
	try {
		const definition = JSON.parse(await readFile('package.json', 'utf8')) as { build: Configuration };
		const runtimeBinaries = ['Contents/Resources/svn/bin/svn', ...(await readdir('resources/svn/darwin-arm64/lib')).map((name) => `Contents/Resources/svn/lib/${name}`)];
		await build({
			targets: Platform.MAC.createTarget(['dir'], Arch.arm64),
			publish: 'never',
			config: {
				...definition.build,
				buildVersion: metadata.version,
				forceCodeSigning: !unsigned,
				directories: { ...definition.build.directories, output: join(stage, 'app') },
				mac: {
					...definition.build.mac,
					identity: builderIdentity(identity),
					notarize: false,
					preAutoEntitlements: false,
					hardenedRuntime: true,
					entitlements: 'resources/entitlements.mac.plist',
					entitlementsInherit: 'resources/entitlements.mac.plist',
					binaries: runtimeBinaries,
				},
			},
		});
		const app = join(stage, 'app/mac-arm64', `${APP_NAME}.app`);
		if (signing) {
			const submission = join(stage, 'notarize.zip');
			await releaseCommand('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, submission]);
			await notarize(submission, signing.keychain);
			await releaseCommand('/usr/bin/xcrun', ['stapler', 'staple', app]);
		}
		await verifyMacApp(app, metadata.version, signing?.teamId);
		const [dmgName, zipName] = archiveNames(metadata.version);
		const zip = join(stage, zipName);
		await releaseCommand('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
		await releaseCommand('/usr/bin/unzip', ['-t', '-qq', zip]);
		const imageSource = join(stage, 'image-source');
		await mkdir(imageSource);
		await releaseCommand('/usr/bin/ditto', [app, join(imageSource, `${APP_NAME}.app`)]);
		await symlink('/Applications', join(imageSource, 'Applications'));
		const dmg = join(stage, dmgName);
		await releaseCommand('/usr/bin/hdiutil', ['create', '-volname', 'svnbox', '-srcfolder', imageSource, '-format', 'UDZO', dmg]);
		if (signing) {
			await releaseCommand('/usr/bin/codesign', ['--sign', identity!, '--keychain', signing.keychain, '--timestamp', dmg]);
			await notarize(dmg, signing.keychain);
			await releaseCommand('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
			await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
			await releaseCommand('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg]);
		}
		await releaseCommand('/usr/bin/hdiutil', ['verify', dmg]);
		await mkdir(metadata.directory, { recursive: true });
		const checksums: string[] = [];
		for (const [name, path] of [
			[dmgName, dmg],
			[zipName, zip],
		]) {
			checksums.push(`${await fileChecksum(path)}  ${name}`);
			await copyFile(path, join(metadata.directory, name));
		}
		await writeFile(join(metadata.directory, 'SHA256SUMS'), checksums.join('\n') + '\n');
		await verifyReleaseFiles(metadata);
		console.log(`${unsigned ? 'Unsigned preview' : 'Signed and notarized'} installers are ready: ${metadata.directory}`);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
