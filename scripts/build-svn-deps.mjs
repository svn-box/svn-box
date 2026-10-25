import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';

export const nativeSources = [
	{
		name: 'apr',
		version: '1.7.6',
		url: 'https://archive.apache.org/dist/apr/apr-1.7.6.tar.bz2',
		sha256: '49030d92d2575da735791b496dc322f3ce5cff9494779ba8cc28c7f46c5deb32',
	},
	{
		name: 'apr-util',
		version: '1.6.5',
		url: 'https://archive.apache.org/dist/apr/apr-util-1.6.5.tar.bz2',
		sha256: '96de1dd6f6a0476d2d2e7964926d8c1ddc3bb0e210e1b1812d3ba5a454a392e2',
	},
	{
		name: 'openssl',
		version: '3.5.9',
		url: 'https://github.com/openssl/openssl/releases/download/openssl-3.5.9/openssl-3.5.9.tar.gz',
		sha256: '603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a',
	},
	{
		name: 'serf',
		version: '1.3.10',
		url: 'https://archive.apache.org/dist/serf/serf-1.3.10.tar.bz2',
		sha256: 'be81ef08baa2516ecda76a77adf7def7bc3227eeb578b9a33b45f7b41dc064e6',
	},
];

export async function buildSvnDependencies(cache) {
	const prefix = join(cache, 'dependencies');
	const recipe = createHash('sha256')
		.update(await readFile(new URL(import.meta.url)))
		.digest('hex');
	const signature = `${process.arch}:macos13:${recipe}`;
	try {
		const metadata = JSON.parse(await readFile(join(prefix, 'sources.json'), 'utf8'));
		await access(join(prefix, 'lib/libserf-1.dylib'));
		if (metadata.signature === signature) {
			return prefix;
		}
	} catch {
		// Missing or changed build output is rebuilt below.
	}
	await mkdir(cache, { recursive: true });
	await rm(prefix, { recursive: true, force: true });
	const sdk = execFileSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
	const env = {
		...process.env,
		MACOSX_DEPLOYMENT_TARGET: '13.0',
		CFLAGS: '-O2 -mmacosx-version-min=13.0',
		LDFLAGS: '-mmacosx-version-min=13.0 -Wl,-headerpad_max_install_names',
		PKG_CONFIG_PATH: join(prefix, 'lib/pkgconfig'),
	};
	const jobs = String(Math.min(availableParallelism(), 8));

	async function run(command, args, cwd) {
		await new Promise((resolve, reject) => {
			const child = spawn(command, args, { cwd, env, shell: false, stdio: 'inherit' });
			child.once('error', reject);
			child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
		});
	}

	for (const item of nativeSources) {
		const archive = join(cache, new URL(item.url).pathname.split('/').at(-1));
		try {
			await access(archive);
		} catch {
			await run('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '15', '--max-time', '180', item.url, '-o', archive], cache);
		}
		if (
			createHash('sha256')
				.update(await readFile(archive))
				.digest('hex') !== item.sha256
		) {
			throw new Error(`${item.name} source checksum mismatch`);
		}
		const directory = join(cache, `${item.name}-${item.version}`);
		await rm(directory, { recursive: true, force: true });
		await run('/usr/bin/tar', ['-xf', archive, '-C', cache], cache);
		console.log(`Building ${item.name} ${item.version} for macOS 13+`);
		if (item.name === 'openssl') {
			await run(
				'./Configure',
				[`darwin64-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-cc`, `--prefix=${prefix}`, '--openssldir=/etc/ssl', '--libdir=lib', 'shared', 'no-tests'],
				directory,
			);
			await run('/usr/bin/make', ['-j', jobs], directory);
			await run('/usr/bin/make', ['install_sw'], directory);
		} else if (item.name === 'serf') {
			await run(
				'scons',
				[
					`APR=${prefix}`,
					`APU=${prefix}`,
					`OPENSSL=${prefix}`,
					`PREFIX=${prefix}`,
					`GSSAPI=${sdk}/usr`,
					`ZLIB=${sdk}/usr`,
					'CC=/usr/bin/clang',
					`CFLAGS=${env.CFLAGS}`,
					`LINKFLAGS=${env.LDFLAGS}`,
					'-j',
					jobs,
					'install',
				],
				directory,
			);
		} else {
			const args = [`--prefix=${prefix}`, '--disable-static'];
			if (item.name === 'apr-util') {
				args.push(`--with-apr=${prefix}`, `--with-expat=${sdk}/usr`, '--without-crypto', '--without-pgsql', '--without-mysql', '--without-odbc');
			}
			await run('./configure', args, directory);
			// APR's bundled libtool races when creating its shared-library links.
			await run('/usr/bin/make', ['-j', item.name === 'apr' ? '1' : jobs], directory);
			await run('/usr/bin/make', ['install'], directory);
		}
	}
	await writeFile(join(prefix, 'sources.json'), JSON.stringify({ signature, sources: nativeSources }, null, 2) + '\n');
	return prefix;
}
