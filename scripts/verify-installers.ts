import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { APP_NAME, archiveNames, fileChecksum, previewMode, readReleaseMetadata, verifyReleaseFiles } from './release-metadata.ts';
import { buildEnvironment, releaseCommand, verifyMacApp } from './release-mac.ts';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
	throw new Error('Installer acceptance requires macOS arm64.');
}
const unsigned = previewMode(process.argv.slice(2), process.env);
const metadata = await readReleaseMetadata(process.cwd(), undefined, unsigned);
const teamId = unsigned ? undefined : process.env.APPLE_TEAM_ID;
if (!unsigned && (!teamId || !/^[A-Z\d]{10}$/.test(teamId))) {
	throw new Error('Signed installer acceptance requires APPLE_TEAM_ID.');
}
await verifyReleaseFiles(metadata);
const [dmg, zip] = archiveNames(metadata.version).map((name) => join(metadata.directory, name));
await releaseCommand('/usr/bin/hdiutil', ['verify', dmg]);
await releaseCommand('/usr/bin/unzip', ['-t', '-qq', zip]);
if (!unsigned) {
	await releaseCommand('/usr/bin/codesign', ['--verify', '--strict', dmg]);
	await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
	await releaseCommand('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg]);
}
const root = resolve('.cache/release-acceptance');
await mkdir(root, { recursive: true });
const acceptance = await mkdtemp(join(root, 'run-'));
const mount = join(acceptance, 'mounted');
let mounted = false;
try {
	const extraction = join(acceptance, 'extracted');
	await mkdir(extraction);
	await releaseCommand('/usr/bin/ditto', ['-x', '-k', zip, extraction]);
	const app = join(extraction, `${APP_NAME}.app`);
	if (!unsigned) {
		await releaseCommand('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${Math.floor(Date.now() / 1000).toString(16)};GitHubActions;${randomUUID()}`, app]);
	}
	await verifyMacApp(app, metadata.version, teamId);
	await mkdir(mount);
	await releaseCommand('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]);
	mounted = true;
	const diskApp = join(mount, `${APP_NAME}.app`);
	await verifyMacApp(diskApp, metadata.version, teamId);
	for (const path of ['Contents/Info.plist', 'Contents/Resources/app.asar', 'Contents/Resources/svn/bin/svn']) {
		if ((await fileChecksum(join(app, path))) !== (await fileChecksum(join(diskApp, path)))) {
			throw new Error('ZIP and DMG do not contain the same application.');
		}
	}
	await releaseCommand('/usr/bin/hdiutil', ['detach', mount]);
	mounted = false;
	const env = { ...buildEnvironment(process.env), SVNBOX_PACKAGED_APP: join(app, 'Contents/MacOS', APP_NAME) };
	for (const script of ['scripts/e2e.mjs', 'scripts/e2e-themes.mjs', 'scripts/e2e-files.mjs', 'scripts/e2e-auth.mjs']) {
		console.log(`Verifying extracted release: ${script}`);
		await new Promise<void>((resolve, reject) => {
			const child = spawn(process.execPath, [script], { env, shell: false, stdio: 'inherit' });
			child.once('error', () => reject(new Error(`Packaged UI check could not start: ${script}`)));
			child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`Packaged UI check failed: ${script}`))));
		});
	}
	await verifyMacApp(app, metadata.version, teamId);
	console.log('Installer checksums, mounted DMG, extracted ZIP and packaged Electron checks passed.');
} finally {
	if (mounted) {
		await releaseCommand('/usr/bin/hdiutil', ['detach', mount]);
	}
	await rm(acceptance, { recursive: true, force: true });
}
