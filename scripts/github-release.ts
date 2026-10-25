import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ReleaseMetadata } from './release-metadata.ts';
import { readReleaseMetadata, RELEASE_REPOSITORY, verifyReleaseFiles } from './release-metadata.ts';
import { ensureReleaseAbsent, readReleaseTarget, verifyUploadedDraft } from './github-release-api.ts';

const execute = promisify(execFile);
type GitHubCommand = (arguments_: string[]) => Promise<void>;

export async function publishRelease(metadata: ReleaseMetadata, commit: string, token: string, run: GitHubCommand): Promise<void> {
	const files = await verifyReleaseFiles(metadata);
	await readReleaseTarget(metadata.tag, commit, token);
	await ensureReleaseAbsent(metadata.tag, token);
	await run([
		'release',
		'create',
		metadata.tag,
		'--repo',
		RELEASE_REPOSITORY,
		'--draft',
		'--target',
		commit,
		'--title',
		`svnbox ${metadata.version}`,
		'--notes-file',
		metadata.notes,
		...files,
	]);
	await verifyUploadedDraft(metadata.tag, token, files);
	await readReleaseTarget(metadata.tag, commit, token);
	await run(['release', 'edit', metadata.tag, '--repo', RELEASE_REPOSITORY, '--draft=false', '--latest']);
}

async function main(): Promise<void> {
	const mode = process.argv[2];
	if (!['check', 'prepare', 'publish'].includes(mode ?? '') || process.argv.length !== 3) {
		throw new Error('Use check, prepare or publish.');
	}
	const preview = process.env.RELEASE_PREVIEW === 'true';
	if (mode !== 'check' && (!process.env.GITHUB_ACTIONS || (!preview && process.env.GITHUB_REF_TYPE !== 'tag'))) {
		throw new Error('Publishing accepts only a GitHub Actions version-tag build.');
	}
	if (preview && mode === 'publish') {
		throw new Error('Preview builds cannot publish a release.');
	}
	const metadata = await readReleaseMetadata(process.cwd(), process.env.GITHUB_REF_TYPE === 'tag' ? (process.env.GITHUB_REF_NAME ?? '') : undefined, preview);
	if (mode === 'check') {
		console.log(`${metadata.tag}: package versions and release notes are ready.`);
		return;
	}
	const token = process.env.GH_TOKEN ?? '';
	const commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
	const workflowSha = process.env.GITHUB_SHA ?? '';
	if (!/^[a-f\d]{40}$/.test(workflowSha) || commit !== (await execute('git', ['rev-parse', `${workflowSha}^{commit}`])).stdout.trim()) {
		throw new Error('Checkout does not match the workflow source commit.');
	}
	if (mode === 'prepare') {
		if (!preview) {
			await readReleaseTarget(metadata.tag, commit, token);
			await ensureReleaseAbsent(metadata.tag, token);
		}
		const output = process.env.GITHUB_OUTPUT;
		if (!output) {
			throw new Error('Missing GitHub Actions output path.');
		}
		await appendFile(output, `version=${metadata.version}\ndirectory=release/${preview ? 'preview/' : ''}${metadata.version}/macos/arm64\ncommit=${commit}\n`);
		return;
	}
	await publishRelease(metadata, commit, token, async (arguments_) => {
		try {
			await execute('gh', arguments_, { env: { ...process.env, GH_TOKEN: token } });
		} catch {
			throw new Error('GitHub Release command failed. Inspect any remaining draft before retrying; no assets are overwritten.');
		}
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
