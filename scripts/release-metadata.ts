import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';

export const RELEASE_REPOSITORY = 'svn-box/svn-box';
export const APP_NAME = '仓盒';
export const APP_ID = 'app.svnbox.desktop';

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

export async function fileChecksum(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const bytes of createReadStream(path)) {
		hash.update(bytes);
	}
	return hash.digest('hex');
}

export async function verifyReleaseFiles(metadata: ReleaseMetadata): Promise<string[]> {
	const archives = archiveNames(metadata.version);
	const expected = [...archives, 'SHA256SUMS'].sort();
	const names = (await readdir(metadata.directory)).sort();
	if (names.join('\n') !== expected.join('\n')) {
		throw new Error('Distribution directory must contain only this version’s DMG, ZIP and SHA256SUMS.');
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
