import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { readReleaseMetadata, writeReleaseFiles, verifyReleaseFiles } from './release-metadata.mjs';
import { prepareSigning, releaseCommand, notarize, verifySignature } from './release-signing.mjs';

const exec = promisify(execFile);
const unsigned = process.argv.length === 3 && process.argv[2] === '--unsigned';
assert.ok(process.argv.length === 2 || unsigned, 'Only --unsigned is supported for local previews.');
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.ok(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim(), 'Missing TAURI_SIGNING_PRIVATE_KEY.');
const metadata = await readReleaseMetadata(resolve('.'), { unsigned, tag: process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined });
const staging = await mkdtemp(join(tmpdir(), 'svnbox-release-'));
const buildEnv = { ...process.env };
for (const name of [
	'GH_TOKEN',
	'GITHUB_TOKEN',
	'BUILD_CERTIFICATE_BASE64',
	'P12_PASSWORD',
	'TAURI_SIGNING_PRIVATE_KEY',
	'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
	'APPLE_APP_SPECIFIC_PASSWORD',
	'APPLE_PASSWORD',
]) {
	delete buildEnv[name];
}
let signing;
try {
	if (!unsigned) {
		signing = await prepareSigning();
		buildEnv.APPLE_ID = process.env.APPLE_ID;
		buildEnv.APPLE_TEAM_ID = signing.teamId;
		buildEnv.APPLE_PASSWORD = process.env.APPLE_APP_SPECIFIC_PASSWORD;
		buildEnv.APPLE_SIGNING_IDENTITY = signing.identity;
		buildEnv.APPLE_SIGNING_KEYCHAIN = signing.keychain;
	}
	console.log('Building the production application and DMG; signing credentials are withheld from logs.');
	const config = JSON.stringify({ bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: signing?.identity ?? '-', hardenedRuntime: true } } });
	await releaseCommand(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--ci', '--bundles', 'app,dmg', '--config', config], buildEnv);
	const bundle = resolve('src-tauri/target/release/bundle');
	const app = join(bundle, 'macos/仓盒.app');
	const dmg = join(bundle, `dmg/仓盒_${metadata.version}_aarch64.dmg`);
	if (signing) {
		await verifySignature(app, signing.teamId, true);
		await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', app]);
		await releaseCommand('/usr/bin/codesign', ['--force', '--sign', signing.identity, '--keychain', signing.keychain, '--timestamp', dmg]);
		console.log('Notarizing and stapling the final DMG.');
		await notarize(dmg, signing.keychain);
	}
	await copyFile(dmg, join(staging, metadata.archives[0]));
	// Archive the final stapled app. Extra AppleDouble metadata is excluded for Tauri's extractor.
	await releaseCommand('/usr/bin/tar', ['--format', 'ustar', '-czf', join(staging, metadata.archives[1]), '-C', join(bundle, 'macos'), '仓盒.app'], {
		...buildEnv,
		COPYFILE_DISABLE: '1',
	});
	await releaseCommand(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'signer', 'sign', '--app-version', metadata.version, join(staging, metadata.archives[1])]);
	assert.ok((await readFile(join(staging, metadata.archives[2]), 'utf8')).trim(), 'Missing updater archive signature.');
	const revision = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
	await writeReleaseFiles(metadata, staging, revision, signing?.teamId);
	await verifyReleaseFiles(metadata, staging);
	await rm(metadata.directory, { recursive: true, force: true });
	await mkdir(metadata.directory, { recursive: true });
	for (const name of [...metadata.archives, 'latest.json', 'release-manifest.json', 'RELEASE-NOTES.md', 'SHA256SUMS']) {
		await copyFile(join(staging, name), join(metadata.directory, name));
	}
	console.log(`Prepared ${metadata.tag}: ${metadata.directory}`);
} finally {
	await rm(staging, { recursive: true, force: true });
}
