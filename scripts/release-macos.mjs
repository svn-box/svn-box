import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { fileChecksum, readReleaseMetadata, writeReleaseFiles, verifyReleaseFiles } from './release-metadata.mjs';
import { prepareSigning, releaseCommand, notarize, verifySignature } from './release-signing.mjs';
import { stageSignedRuntime } from './native-runtime-signing.mjs';

const exec = promisify(execFile);
const mode = process.argv[2];
const unsigned = mode === '--unsigned';
assert.ok(
	process.argv.length === 2 || (process.argv.length === 3 && (unsigned || mode === '--resume')),
	'Use --resume for an existing signed candidate or --unsigned for a preview.',
);
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
const metadata = await readReleaseMetadata(resolve('.'), { unsigned });
const revision = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();

async function checkSource() {
	assert.equal((await exec('git', ['rev-parse', `refs/tags/${metadata.tag}^{commit}`])).stdout.trim(), revision, 'Check out the matching release tag.');
	assert.equal((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), revision, 'Source changed while building.');
	assert.equal((await exec('git', ['status', '--porcelain'])).stdout.trim(), '', 'Build the release tag in a clean checkout.');
}

if (!unsigned) {
	await checkSource();
}
const buildEnv = { ...process.env };
for (const key of Object.keys(buildEnv)) {
	if (/^(APPLE_|CSC_|TAURI_SIGNING_|GH_|GITHUB_TOKEN$|BUILD_CERTIFICATE_|P12_)/.test(key)) {
		delete buildEnv[key];
	}
}
const work = resolve('work/release');
await mkdir(work, { recursive: true });
const temporary = await mkdtemp(join(work, 'build-'));
const staging = join(temporary, 'distribution');
const candidate = join(work, `${metadata.tag}-${revision}`);
const zip = join(candidate, 'application.zip');
await mkdir(staging);
try {
	const signing = unsigned ? undefined : await prepareSigning();
	const config = { bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: signing?.identity ?? '-', hardenedRuntime: true } } };
	const bundle = resolve('src-tauri/target/release/bundle');
	let app = join(bundle, 'macos/仓盒.app');
	let dmg = join(bundle, `dmg/仓盒_${metadata.version}_aarch64.dmg`);
	if (mode !== '--resume') {
		if (signing) {
			buildEnv.APPLE_SIGNING_IDENTITY = signing.identity;
			if (signing.keychain) {
				buildEnv.APPLE_SIGNING_KEYCHAIN = signing.keychain;
			}
			assert.equal(metadata.config.bundle.resources['../resources/svn/darwin-arm64/'], 'svn/');
			const runtime = await stageSignedRuntime(resolve('resources/svn/darwin-arm64'), join(temporary, 'signed-runtime'), signing);
			config.bundle.resources = { '../resources/svn/darwin-arm64/': null, [runtime]: 'svn/' };
		}
		console.log(`Building ${metadata.tag} locally.`);
		await releaseCommand(
			process.execPath,
			['node_modules/@tauri-apps/cli/tauri.js', 'build', '--ci', '--bundles', signing ? 'app' : 'app,dmg', '--config', JSON.stringify(config)],
			buildEnv,
		);
		if (signing) {
			await verifySignature(app, signing.teamId, true);
			await checkSource();
			await mkdir(candidate, { recursive: true });
			const packed = join(temporary, 'application.zip');
			await releaseCommand('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, packed]);
			await rename(packed, zip);
			await writeFile(join(candidate, 'SHA256'), await fileChecksum(zip));
			console.log(`Signed candidate saved at ${zip}`);
		}
	}
	if (signing) {
		assert.equal(await fileChecksum(zip), await readFile(join(candidate, 'SHA256'), 'utf8'), 'Signed candidate checksum differs.');
		const image = join(temporary, 'image');
		await mkdir(image);
		await releaseCommand('/usr/bin/ditto', ['-x', '-k', zip, image]);
		app = join(image, '仓盒.app');
		await verifySignature(app, signing.teamId, true);
		console.log('Submitting the signed app to Apple for notarization.');
		await notarize(zip, signing, app);
		await symlink('/Applications', join(image, 'Applications'));
		dmg = join(temporary, metadata.archives[0]);
		await releaseCommand('/usr/bin/hdiutil', ['create', '-volname', '仓盒', '-srcfolder', image, '-fs', 'HFS+', '-format', 'UDZO', dmg]);
		await releaseCommand('/usr/bin/codesign', ['--force', '--sign', signing.identity, ...(signing.keychain ? ['--keychain', signing.keychain] : []), '--timestamp', dmg]);
		console.log('Submitting the final DMG to Apple for notarization.');
		await notarize(dmg, signing);
	}
	await copyFile(dmg, join(staging, metadata.archives[0]));
	await releaseCommand('/usr/bin/tar', ['--format', 'ustar', '-czf', join(staging, metadata.archives[1]), '-C', resolve(app, '..'), '仓盒.app'], {
		...buildEnv,
		COPYFILE_DISABLE: '1',
	});
	await releaseCommand(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign', '--app-version', metadata.version, join(staging, metadata.archives[1])], {
		...buildEnv,
		...(process.env.TAURI_SIGNING_PRIVATE_KEY
			? { TAURI_SIGNING_PRIVATE_KEY: process.env.TAURI_SIGNING_PRIVATE_KEY }
			: { TAURI_SIGNING_PRIVATE_KEY_PATH: process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || join(homedir(), '.config/svnbox/signing/tauri-updater.key') }),
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
	});
	if (signing) {
		await checkSource();
	}
	await writeReleaseFiles(metadata, staging, revision, signing?.teamId);
	await verifyReleaseFiles(metadata, staging);
	await mkdir(metadata.directory, { recursive: true });
	for (const name of [...metadata.archives, 'latest.json', 'release-manifest.json', 'RELEASE-NOTES.md', 'SHA256SUMS']) {
		await copyFile(join(staging, name), join(metadata.directory, name));
	}
	await verifyReleaseFiles(metadata);
	console.log(`Prepared ${metadata.tag}: ${metadata.directory}`);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
