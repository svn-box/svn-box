import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readReleaseMetadata, verifyReleaseFiles, updateManifest } from './release-metadata.mjs';
import { ensureReleaseAbsent, readReleaseTarget, releaseRepository, verifyUploadedDraft } from './github-release-api.mjs';

const execute = promisify(execFile);

export async function publishRelease(metadata, commit, repository, token, run) {
	assert.equal(metadata.unsigned, false, 'Unsigned previews cannot publish a release.');
	const manifest = await verifyReleaseFiles(metadata);
	assert.equal(manifest.sourceRevision, commit, 'Release artifacts do not match the source commit.');
	const files = [...metadata.archives, updateManifest, 'RELEASE-NOTES.md', 'release-manifest.json', 'SHA256SUMS'].map((name) => join(metadata.directory, name));
	await readReleaseTarget(repository, metadata.tag, commit, token);
	await ensureReleaseAbsent(repository, metadata.tag, token);
	await run([
		'release',
		'create',
		metadata.tag,
		'--repo',
		repository,
		'--verify-tag',
		'--draft',
		'--target',
		commit,
		'--title',
		`仓盒 ${metadata.version}`,
		'--notes-file',
		metadata.notes,
		...files,
	]);
	await verifyUploadedDraft(repository, metadata.tag, token, files);
	await readReleaseTarget(repository, metadata.tag, commit, token);
	await run(['release', 'edit', metadata.tag, '--repo', repository, '--draft=false', '--latest']);
}

async function main() {
	const mode = process.argv[2];
	assert.ok(['prepare', 'publish'].includes(mode) && process.argv.length === 3, 'Use prepare or publish.');
	assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Release orchestration runs only in GitHub Actions.');
	const preview = process.env.RELEASE_PREVIEW === 'true';
	assert.ok(preview || process.env.GITHUB_REF_TYPE === 'tag', 'Publishing requires a version tag.');
	assert.ok(!preview || mode !== 'publish', 'Preview builds cannot publish.');
	const metadata = await readReleaseMetadata(resolve('.'), { unsigned: preview, tag: process.env.GITHUB_REF_TYPE === 'tag' ? (process.env.GITHUB_REF_NAME ?? '') : undefined });
	const repository = releaseRepository();
	const token = process.env.GH_TOKEN ?? '';
	const commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
	assert.match(process.env.GITHUB_SHA ?? '', /^[a-f\d]{40}$/, 'Missing workflow source commit.');
	assert.equal(commit, (await execute('git', ['rev-parse', `${process.env.GITHUB_SHA}^{commit}`])).stdout.trim(), 'Checkout does not match the workflow source commit.');
	if (mode === 'prepare') {
		if (!preview) {
			await readReleaseTarget(repository, metadata.tag, commit, token);
			await ensureReleaseAbsent(repository, metadata.tag, token);
		}
		assert.ok(process.env.GITHUB_OUTPUT, 'Missing GitHub Actions output path.');
		await appendFile(process.env.GITHUB_OUTPUT, `version=${metadata.version}\ndirectory=${relative(metadata.root, metadata.directory)}\ncommit=${commit}\n`);
		return;
	}
	await publishRelease(metadata, commit, repository, token, async (arguments_) => {
		try {
			await execute('gh', arguments_, { env: { ...process.env, GH_TOKEN: token, GH_DEBUG: '' }, maxBuffer: 4 * 1024 * 1024 });
		} catch {
			throw new Error('GitHub Release command failed. Inspect any remaining draft before retrying; no existing assets are overwritten.');
		}
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
