import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, copyFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { buildSvnDependencies, nativeSources } from './build-svn-deps.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '1.15.0';
const sourceUrl = `https://archive.apache.org/dist/subversion/subversion-${version}.tar.bz2`;
const sourceHash = 'dfb7b1e5270c7def971ccbd5938b0c03b1b5bd60b6674a2d8a74a9560839fb8c';
const cache = join(root, '.cache/svn-runtime');
const source = join(cache, `subversion-${version}`);
const prefix = join(cache, 'installed');
const output = join(root, `resources/svn/darwin-${process.arch}`);
const patch = join(root, 'resources/native-patches/svn-client-first.patch');
const patchHash = createHash('sha256')
	.update(await readFile(patch))
	.digest('hex');
const recipeHash = createHash('sha256')
	.update(await readFile(new URL(import.meta.url)))
	.update(await readFile(new URL('./build-svn-deps.mjs', import.meta.url)))
	.digest('hex');
const signature = `${version}:${process.arch}:${patchHash}:${recipeHash}`;
let dependencyPrefix;

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function run(command, args, options = {}) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: source, stdio: 'inherit', shell: false, ...options });
		child.once('error', reject);
		child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
	});
}

function capture(command, args) {
	return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

async function bundleRuntime() {
	await rm(output, { recursive: true, force: true });
	await mkdir(join(output, 'bin'), { recursive: true });
	await mkdir(join(output, 'lib'), { recursive: true });
	const copied = new Map();

	async function copyBinary(original, executable = false) {
		const canonical = await realpath(original);
		const name = executable ? 'svn' : basename(original);
		const destination = join(output, executable ? 'bin' : 'lib', name);
		if (copied.has(destination)) {
			if (copied.get(destination) !== canonical) {
				throw new Error(`Conflicting native dependency: ${name}`);
			}
			return;
		}
		copied.set(destination, canonical);
		await copyFile(canonical, destination);
		await chmod(destination, 0o755);
		const references = capture('/usr/bin/otool', ['-L', original])
			.split('\n')
			.slice(1)
			.map((line) => line.trim().split(' (compatibility')[0]);
		const changes = [];
		for (const reference of references) {
			if (reference.startsWith('/usr/lib/') || reference.startsWith('/System/Library/')) {
				continue;
			}
			if (!reference.startsWith(dependencyPrefix + '/') && !reference.startsWith(prefix + '/')) {
				throw new Error(`Unresolved native dependency: ${reference}`);
			}
			if ((await realpath(reference)) === canonical && !executable) {
				continue;
			}
			await copyBinary(reference);
			changes.push('-change', reference, `${executable ? '@executable_path/../lib' : '@loader_path'}/${basename(reference)}`);
		}
		const args = [...(!executable ? ['-id', `@loader_path/${name}`] : []), ...changes, destination];
		await run('/usr/bin/install_name_tool', args);
	}

	console.log('Bundling native runtime and its shared libraries');
	await copyBinary(join(prefix, 'bin/svn'), true);
	for (const path of copied.keys()) {
		await run('/usr/bin/codesign', ['--force', '--sign', '-', path]);
	}
	const licenses = join(output, 'licenses');
	await mkdir(join(licenses, 'subversion'), { recursive: true });
	for (const name of ['LICENSE', 'NOTICE']) {
		await copyFile(join(source, name), join(licenses, 'subversion', name));
	}
	for (const item of nativeSources) {
		const directory = join(cache, `${item.name}-${item.version}`);
		const name = item.name;
		await mkdir(join(licenses, name), { recursive: true });
		for (const entry of await readdir(directory)) {
			if (/^(LICENSE|NOTICE|COPYING)(\.|$)/i.test(entry)) {
				await copyFile(join(directory, entry), join(licenses, name, entry));
			}
		}
	}
	await copyFile(patch, join(output, 'svn-client-first.patch'));
	await writeFile(
		join(output, 'manifest.json'),
		JSON.stringify(
			{
				signature,
				version,
				sourceUrl,
				sourceSha256: sourceHash,
				patchSha256: patchHash,
				platform: 'darwin',
				arch: process.arch,
				minimumMacOS: '13.0',
				change: 'One leading space for plain svn TCP connections; original greeting and authentication remain intact.',
				dependencies: nativeSources,
			},
			null,
			2,
		) + '\n',
	);
	const references = [...copied.keys()].flatMap((path) => capture('/usr/bin/otool', ['-L', path]).split('\n').slice(1));
	if (references.some((line) => /\/opt\/homebrew\/|\/\.cache\//.test(line))) {
		throw new Error('Bundled runtime still depends on the development machine');
	}
	console.log(capture(join(output, 'bin/svn'), ['--version', '--quiet']));
}

if (process.platform !== 'darwin') {
	throw new Error('Build the macOS SVN runtime on macOS');
}
if (await exists(join(output, 'manifest.json'))) {
	const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
	if (manifest.signature === signature && (await exists(join(output, 'bin/svn')))) {
		console.log(`SVN ${version} runtime is ready (${process.arch})`);
		process.exit(0);
	}
}
await mkdir(cache, { recursive: true });
dependencyPrefix = await buildSvnDependencies(cache);
const archive = join(cache, `subversion-${version}.tar.bz2`);
if (!(await exists(archive))) {
	await run('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '15', '--max-time', '180', sourceUrl, '-o', archive], { cwd: root });
}
if (
	createHash('sha256')
		.update(await readFile(archive))
		.digest('hex') !== sourceHash
) {
	throw new Error('Subversion source checksum mismatch');
}
await rm(source, { recursive: true, force: true });
await run('/usr/bin/tar', ['-xjf', archive, '-C', cache], { cwd: root });
await run('/usr/bin/patch', ['--batch', '-p1', '-i', patch]);
const sdk = capture('/usr/bin/xcrun', ['--show-sdk-path']);
const env = {
	...process.env,
	MACOSX_DEPLOYMENT_TARGET: '13.0',
	CFLAGS: '-O2 -mmacosx-version-min=13.0',
	LDFLAGS: '-Wl,-headerpad_max_install_names',
	PKG_CONFIG_PATH: join(dependencyPrefix, 'lib/pkgconfig'),
};
console.log('Configuring pinned Apache Subversion source');
await run(
	'./configure',
	[
		`--prefix=${prefix}`,
		'--disable-static',
		'--disable-nls',
		'--disable-plaintext-password-storage',
		'--enable-sqlite-compatibility-version=3.36.0',
		`--with-apr=${dependencyPrefix}`,
		`--with-apr-util=${dependencyPrefix}`,
		`--with-serf=${dependencyPrefix}`,
		'--with-sasl=/usr',
		`--with-sqlite=${sdk}/usr`,
		`--with-zlib=${sdk}/usr`,
		'--with-lz4=internal',
		'--with-utf8proc=internal',
		'--without-apxs',
		'--without-berkeley-db',
		'--without-gpg-agent',
		'--without-swig-python',
		'--without-swig-perl',
		'--without-swig-ruby',
	],
	{ env },
);
console.log('Building SVN runtime');
await run('/usr/bin/make', ['-j', String(Math.min(availableParallelism(), 8)), 'install'], { env });
await bundleRuntime();
