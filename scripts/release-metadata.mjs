import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyUpdateSignature } from './update-signature.mjs';

export const updateManifest = 'latest.json';
export const repository = 'svn-box/svn-box';

export async function readReleaseMetadata(root = resolve('.'), { tag, unsigned = false } = {}) {
	assert.ok(!unsigned || process.env.GITHUB_REF_TYPE !== 'tag', 'Version tags cannot publish unsigned builds.');
	const definition = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
	const { version } = definition;
	assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Release requires a stable three-part version.');
	if (tag !== undefined) {
		assert.equal(tag, `v${version}`, 'Release tag must match the package version.');
	}
	const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
	assert.equal(lock.version, version);
	assert.equal(lock.packages[''].version, version);
	const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
	assert.equal(config.version, version, 'Tauri version differs from npm.');
	assert.equal(config.identifier, 'app.svnbox.desktop');
	for (const file of ['Cargo.toml', 'Cargo.lock']) {
		const contents = await readFile(join(root, 'src-tauri', file), 'utf8');
		assert.equal(contents.match(/name = "svnbox-app"\nversion = "([^"]+)"/)?.[1], version, `Invalid ${file} version.`);
	}
	assert.deepEqual(config.plugins.updater.endpoints, [`https://github.com/${repository}/releases/latest/download/latest.json`]);
	assert.equal(config.plugins.updater.requireSignedVersion, true);
	assert.equal(config.plugins.updater.allowDowngrades, false);
	assert.ok(config.plugins.updater.pubkey.length > 50, 'Missing updater public key.');
	const notes = join(root, 'docs/releases', `${version}.md`);
	assert.ok((await lstat(notes)).isFile());
	assert.ok((await readFile(notes, 'utf8')).startsWith(`# 仓盒 ${version}\n`), 'Release notes heading must match the version.');
	const prefix = `svnbox-${version}-arm64`;
	const archives = [`${prefix}.dmg`, `${prefix}.app.tar.gz`, `${prefix}.app.tar.gz.sig`];
	return {
		root,
		definition,
		config,
		version,
		tag: `v${version}`,
		notes,
		archives,
		unsigned,
		directory: join(root, 'release', ...(unsigned ? ['preview'] : []), version, 'macos', 'arm64'),
	};
}

export async function fileChecksum(path) {
	const hash = createHash('sha256');
	for await (const bytes of createReadStream(path)) {
		hash.update(bytes);
	}
	return hash.digest('hex');
}

export async function writeReleaseFiles(metadata, directory, revision, teamId) {
	assert.match(revision, /^[a-f\d]{40}$/);
	if (!metadata.unsigned) {
		assert.match(teamId ?? '', /^[A-Z\d]{10}$/);
	}
	const signature = (await readFile(join(directory, metadata.archives[2]), 'utf8')).trim();
	const builtAt = new Date().toISOString();
	const update = {
		version: metadata.version,
		notes: await readFile(metadata.notes, 'utf8'),
		pub_date: builtAt,
		platforms: { 'darwin-aarch64': { signature, url: `https://github.com/${repository}/releases/download/${metadata.tag}/${metadata.archives[1]}` } },
	};
	await writeFile(join(directory, updateManifest), JSON.stringify(update, null, 2) + '\n');
	await copyFile(metadata.notes, join(directory, 'RELEASE-NOTES.md'));
	const files = await Promise.all(
		metadata.archives.map(async (name) => ({ name, bytes: (await lstat(join(directory, name))).size, sha256: await fileChecksum(join(directory, name)) })),
	);
	await writeFile(
		join(directory, 'release-manifest.json'),
		JSON.stringify(
			{
				version: metadata.version,
				tag: metadata.tag,
				platform: 'darwin',
				arch: 'arm64',
				bundleId: metadata.config.identifier,
				developerIdSigned: !metadata.unsigned,
				notarized: !metadata.unsigned,
				...(metadata.unsigned ? {} : { teamId }),
				sourceRevision: revision,
				builtAt,
				files,
			},
			null,
			2,
		) + '\n',
	);
	const checksums = await Promise.all(
		[...metadata.archives, updateManifest, 'release-manifest.json', 'RELEASE-NOTES.md'].map(async (name) => `${await fileChecksum(join(directory, name))}  ${name}`),
	);
	await writeFile(join(directory, 'SHA256SUMS'), checksums.join('\n') + '\n');
}

export async function verifyReleaseFiles(metadata, directory = metadata.directory) {
	const names = [...metadata.archives, updateManifest, 'release-manifest.json', 'RELEASE-NOTES.md'];
	assert.deepEqual((await readdir(directory)).sort(), [...names, 'SHA256SUMS'].sort(), 'Unexpected or missing distribution files.');
	for (const name of [...names, 'SHA256SUMS']) {
		const info = await lstat(join(directory, name));
		assert.ok(info.isFile() && info.size > 0, `Invalid release file: ${name}`);
	}
	const hashes = await Promise.all(names.map(async (name) => `${await fileChecksum(join(directory, name))}  ${name}`));
	assert.deepEqual((await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/).sort(), hashes.sort(), 'Release checksums do not match.');
	const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'));
	for (const [key, value] of Object.entries({
		version: metadata.version,
		tag: metadata.tag,
		platform: 'darwin',
		arch: 'arm64',
		bundleId: metadata.config.identifier,
		developerIdSigned: !metadata.unsigned,
		notarized: !metadata.unsigned,
	})) {
		assert.equal(manifest[key], value, `Invalid release manifest ${key}.`);
	}
	assert.match(manifest.sourceRevision, /^[a-f\d]{40}$/);
	assert.ok(Number.isFinite(Date.parse(manifest.builtAt)));
	if (!metadata.unsigned) {
		assert.match(manifest.teamId ?? '', /^[A-Z\d]{10}$/);
	}
	const files = await Promise.all(
		metadata.archives.map(async (name) => ({ name, bytes: (await lstat(join(directory, name))).size, sha256: await fileChecksum(join(directory, name)) })),
	);
	assert.deepEqual(manifest.files, files);
	const notes = await readFile(metadata.notes, 'utf8');
	assert.equal(await readFile(join(directory, 'RELEASE-NOTES.md'), 'utf8'), notes);
	const signature = (await readFile(join(directory, metadata.archives[2]), 'utf8')).trim();
	const update = JSON.parse(await readFile(join(directory, updateManifest), 'utf8'));
	assert.deepEqual(update, {
		version: metadata.version,
		notes,
		pub_date: manifest.builtAt,
		platforms: { 'darwin-aarch64': { signature, url: `https://github.com/${repository}/releases/download/${metadata.tag}/${metadata.archives[1]}` } },
	});
	verifyUpdateSignature(await readFile(join(directory, metadata.archives[1])), signature, metadata.config.plugins.updater.pubkey, metadata.version);
	return manifest;
}
