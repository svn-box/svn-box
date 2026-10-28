import assert from 'node:assert/strict';
import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileChecksum, repository } from './release-metadata.mjs';
import { readGitHubJson } from './github-api.mjs';

export function releaseRepository(env = process.env) {
	assert.match(env.GITHUB_REPOSITORY ?? '', /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/, 'Missing or invalid GitHub repository.');
	assert.equal(env.GITHUB_REPOSITORY, repository, 'Release repository must match the configured updater feed.');
	return env.GITHUB_REPOSITORY;
}

export async function readReleaseTarget(repository, tag, commit, token) {
	assert.match(commit, /^[a-f\d]{40}$/, 'Release requires an exact source commit.');
	const target = await readGitHubJson(`repos/${repository}/commits/${encodeURIComponent(tag)}`, token);
	assert.equal(target.sha, commit, 'Release tag no longer matches the built source commit.');
}

export async function findRelease(repository, tag, token) {
	for (let page = 1; page <= 1000; page += 1) {
		const releases = await readGitHubJson(`repos/${repository}/releases?per_page=100&page=${page}`, token);
		assert.ok(Array.isArray(releases), 'Invalid GitHub release list.');
		const release = releases.find((entry) => entry.tag_name === tag);
		if (release || releases.length < 100) {
			return release;
		}
	}
	throw new Error('Release list is too long to confirm availability.');
}

export async function ensureReleaseAbsent(repository, tag, token) {
	assert.ok(!(await findRelease(repository, tag, token)), `${tag} already has a release or draft; existing assets will not be overwritten.`);
}

export async function verifyUploadedDraft(repository, tag, token, files) {
	const release = await findRelease(repository, tag, token);
	assert.ok(release?.draft === true && release.prerelease === false, 'Uploaded release must remain a stable-version draft during verification.');
	assert.ok(Array.isArray(release.assets), 'GitHub release assets are missing.');
	assert.deepEqual(release.assets.map((asset) => asset.name).sort(), files.map((path) => basename(path)).sort(), 'Draft must contain exactly the expected files.');
	for (const path of files) {
		const asset = release.assets.find((entry) => entry.name === basename(path));
		assert.ok(
			asset.state === 'uploaded' && asset.size === (await lstat(path)).size && asset.digest === `sha256:${await fileChecksum(path)}`,
			`Uploaded asset failed size, state or SHA-256 verification: ${basename(path)}`,
		);
	}
}
