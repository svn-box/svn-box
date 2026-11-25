import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readReleaseMetadata, verifyReleaseFiles, updateManifest, repository } from './release-metadata.mjs';
import { ensureReleaseAbsent, readReleaseTarget, verifyUploadedDraft } from './github-release-api.mjs';
import { readGitHubJson } from './github-api.mjs';

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

async function githubToken() {
	const configured = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
	if (configured) {
		return configured;
	}
	const auth = await execute('gh', ['auth', 'token', '--hostname', 'github.com']).catch(() => undefined);
	if (auth?.stdout.trim()) {
		return auth.stdout.trim();
	}
	return new Promise((done, reject) => {
		const child = execFile('git', ['credential', 'fill'], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 15000 }, (error, stdout) => {
			const token = stdout
				.split('\n')
				.find((line) => line.startsWith('password='))
				?.slice(9);
			if (error || !token) {
				reject(new Error('Sign in to github.com with gh auth login or the Git credential helper.'));
			} else {
				done(token);
			}
		});
		child.stdin.end(`protocol=https\nhost=github.com\npath=${repository}.git\n\n`);
	});
}

async function main() {
	const mode = process.argv[2];
	assert.ok(['prepare', 'publish'].includes(mode) && process.argv.length === 3, 'Use prepare or publish.');
	const metadata = await readReleaseMetadata();
	const commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
	const token = await githubToken();
	await readReleaseTarget(repository, metadata.tag, commit, token);
	await ensureReleaseAbsent(repository, metadata.tag, token);
	if (mode === 'prepare') {
		console.log(`Ready to publish ${metadata.tag} from ${commit}.`);
		return;
	}
	// Validate the downloadable files on the Mac, including Gatekeeper and both stapled tickets.
	await execute(process.execPath, [fileURLToPath(new URL('./verify-release.mjs', import.meta.url))], { timeout: 15 * 60 * 1000 });
	await publishRelease(metadata, commit, repository, token, async (arguments_) => {
		try {
			await execute('gh', arguments_, { env: { ...process.env, GH_TOKEN: token, GH_DEBUG: '' }, maxBuffer: 4 * 1024 * 1024 });
		} catch {
			throw new Error('GitHub Release command failed. Inspect any remaining draft before retrying; no existing assets are overwritten.');
		}
	});
	const published = await readGitHubJson(`repos/${repository}/releases/latest`, token);
	assert.equal(published.tag_name, metadata.tag, 'Unexpected latest GitHub Release.');
	console.log(`Published ${published.html_url}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
