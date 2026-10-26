import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const RELEASE_REPOSITORY = 'svn-box/svn-box';
export const APP_NAME = '仓盒';
export const APP_ID = 'app.svnbox.desktop';
export const UPDATE_MANIFEST = 'latest-mac.yml';

export interface ReleaseMetadata {
	version: string;
	tag: string;
	directory: string;
	notes: string;
}

export async function readReleaseMetadata(root: string, tag?: string, preview = false): Promise<ReleaseMetadata> {
	const { version } = z.object({ version: z.string() }).parse(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')));
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
		throw new Error('Release requires a stable three-part version.');
	}
	if (tag !== undefined && tag !== `v${version}`) {
		throw new Error(`Tag ${tag} does not match package version ${version}.`);
	}
	const lock = z
		.object({ version: z.string(), packages: z.object({ '': z.object({ version: z.string() }) }) })
		.parse(JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')));
	if (lock.version !== version || lock.packages[''].version !== version) {
		throw new Error('package.json and package-lock.json versions do not match.');
	}
	const notes = resolve(root, 'release-notes', `${version}.md`);
	if (!(await lstat(notes)).isFile() || !(await readFile(notes, 'utf8')).trim()) {
		throw new Error('Release notes must be a nonempty regular file.');
	}
	return {
		version,
		tag: `v${version}`,
		directory: resolve(root, 'release', ...(preview ? ['preview'] : []), version, 'macos', 'arm64'),
		notes,
	};
}

export function archiveNames(version: string): [string, string] {
	return [`svnbox-${version}-arm64.dmg`, `svnbox-${version}-arm64.zip`];
}

export async function fileChecksum(path: string, algorithm: 'sha256' | 'sha512' = 'sha256'): Promise<string> {
	const hash = createHash(algorithm);
	for await (const bytes of createReadStream(path)) {
		hash.update(bytes);
	}
	return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex');
}

export async function writeUpdateManifest(metadata: ReleaseMetadata): Promise<void> {
	const name = archiveNames(metadata.version)[1];
	const path = join(metadata.directory, name);
	const sha512 = await fileChecksum(path, 'sha512');
	const manifest = { version: metadata.version, files: [{ url: name, sha512, size: (await lstat(path)).size }], path: name, sha512, releaseDate: new Date().toISOString() };
	// The updater accepts JSON as YAML; hashes refer to the final notarized ZIP.
	await writeFile(join(metadata.directory, UPDATE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}

export async function verifyReleaseFiles(metadata: ReleaseMetadata): Promise<string[]> {
	const archives = [...archiveNames(metadata.version), UPDATE_MANIFEST];
	const expected = [...archives, 'SHA256SUMS'].sort();
	const names = (await readdir(metadata.directory)).sort();
	if (names.join('\n') !== expected.join('\n')) {
		throw new Error('Distribution directory must contain only this version’s DMG, ZIP, update manifest and SHA256SUMS.');
	}
	for (const name of names) {
		const stat = await lstat(join(metadata.directory, name));
		if (!stat.isFile() || stat.size === 0) {
			throw new Error(`Invalid distribution file: ${name}`);
		}
	}
	const checksums = (await readFile(join(metadata.directory, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/).sort();
	const actual: string[] = [];
	for (const name of archives) {
		actual.push(`${await fileChecksum(join(metadata.directory, name))}  ${name}`);
	}
	if (checksums.join('\n') !== actual.sort().join('\n')) {
		throw new Error('Distribution SHA256 checksums do not match.');
	}
	const zipName = archiveNames(metadata.version)[1];
	const zip = join(metadata.directory, zipName);
	const sha512 = await fileChecksum(zip, 'sha512');
	const manifest = z
		.object({
			version: z.literal(metadata.version),
			files: z.tuple([z.object({ url: z.literal(zipName), sha512: z.literal(sha512), size: z.literal((await lstat(zip)).size) }).strict()]),
			path: z.literal(zipName),
			sha512: z.literal(sha512),
			releaseDate: z.iso.datetime(),
		})
		.strict();
	manifest.parse(JSON.parse(await readFile(join(metadata.directory, UPDATE_MANIFEST), 'utf8')));
	return expected.map((name) => join(metadata.directory, name));
}

export function previewMode(arguments_: string[], env: NodeJS.ProcessEnv): boolean {
	const unsigned = arguments_.length === 1 && arguments_[0] === '--unsigned';
	if (arguments_.length && !unsigned) {
		throw new Error('Only the optional --unsigned preview flag is supported.');
	}
	if (unsigned && env.GITHUB_REF_TYPE === 'tag') {
		throw new Error('Version tags cannot use unsigned preview installers.');
	}
	return unsigned;
}
