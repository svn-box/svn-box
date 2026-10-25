import { lstat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { fileChecksum, RELEASE_REPOSITORY } from './release-metadata.ts';

const releaseSchema = z.object({
	tag_name: z.string(),
	draft: z.boolean(),
	prerelease: z.boolean(),
	assets: z.array(z.object({ name: z.string(), size: z.number(), state: z.string(), digest: z.string().nullable().optional() })),
});
export type RepositoryRelease = z.infer<typeof releaseSchema>;

async function request(path: string, token: string): Promise<Response> {
	if (!token.trim()) {
		throw new Error('Missing GitHub release token.');
	}
	try {
		return await fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}${path}`, {
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${token}`,
				'User-Agent': 'svnbox-release',
				'X-GitHub-Api-Version': '2022-11-28',
			},
			signal: AbortSignal.timeout(30000),
		});
	} catch {
		throw new Error('GitHub release request failed.');
	}
}

export async function readReleaseTarget(tag: string, commit: string, token: string): Promise<string> {
	if (!/^[a-f\d]{40}$/.test(commit)) {
		throw new Error('Release requires the exact source commit.');
	}
	const response = await request('', token);
	if (!response.ok) {
		throw new Error(`Cannot read release repository: HTTP ${response.status}.`);
	}
	if (z.object({ private: z.boolean() }).parse(await response.json()).private) {
		throw new Error('The distribution repository must be public.');
	}
	const target = await request(`/commits/${encodeURIComponent(tag)}`, token);
	if (!target.ok) {
		throw new Error(`Cannot resolve the pushed release tag: HTTP ${target.status}.`);
	}
	const actual = z.object({ sha: z.string().regex(/^[a-f\d]{40}$/) }).parse(await target.json()).sha;
	if (actual !== commit) {
		throw new Error('Release tag no longer matches the built source commit.');
	}
	return actual;
}

export async function findRelease(tag: string, token: string): Promise<RepositoryRelease | undefined> {
	// Authenticated pagination includes drafts, unlike a public tag lookup.
	for (let page = 1; page <= 1000; page++) {
		const response = await request(`/releases?per_page=100&page=${page}`, token);
		if (!response.ok) {
			throw new Error(`Cannot read release list: HTTP ${response.status}.`);
		}
		const releases = z.array(releaseSchema).parse(await response.json());
		const release = releases.find((entry) => entry.tag_name === tag);
		if (release || releases.length < 100) {
			return release;
		}
	}
	throw new Error('Release list is too long to confirm availability.');
}

export async function ensureReleaseAbsent(tag: string, token: string): Promise<void> {
	if (await findRelease(tag, token)) {
		throw new Error(`${tag} already has a release or draft; existing assets will not be overwritten.`);
	}
}

export async function verifyUploadedDraft(tag: string, token: string, files: string[]): Promise<void> {
	const release = await findRelease(tag, token);
	const expected = files.map((path) => basename(path)).sort();
	if (
		!release?.draft ||
		release.prerelease ||
		release.assets
			.map((asset) => asset.name)
			.sort()
			.join('\n') !== expected.join('\n')
	) {
		throw new Error('Uploaded release must be a draft with exactly the expected files.');
	}
	for (const path of files) {
		const asset = release.assets.find((entry) => entry.name === basename(path));
		if (asset?.state !== 'uploaded' || asset.size !== (await lstat(path)).size || asset.digest !== `sha256:${await fileChecksum(path)}`) {
			throw new Error(`Uploaded asset failed size, state or SHA256 verification: ${basename(path)}`);
		}
	}
}
