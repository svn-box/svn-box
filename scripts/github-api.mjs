import { execFile } from 'node:child_process';

export async function readGitHubJson(path, token) {
	if (!token?.trim()) {
		throw new Error('Missing GitHub release token.');
	}
	const output = await new Promise((done, reject) => {
		execFile(
			'gh',
			['api', path, '--hostname', 'github.com', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'],
			{ env: { ...process.env, GH_TOKEN: token, GH_DEBUG: '' }, timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
			(error, stdout, stderr) => {
				if (error) {
					const status = stderr.match(/\(HTTP (\d{3})\)/)?.[1];
					reject(new Error(`GitHub API request failed${status ? `: HTTP ${status}` : ''}.`));
				} else {
					done(stdout);
				}
			},
		);
	});
	try {
		return JSON.parse(output);
	} catch {
		throw new Error('GitHub API returned invalid JSON.');
	}
}
