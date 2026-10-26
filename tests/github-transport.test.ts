import { afterEach, expect, it, vi } from 'vitest';
import { readReleaseTarget } from '../scripts/github-release-api.ts';

const execute = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile: (...args: unknown[]) => execute(...args) }));

afterEach(() => {
	vi.unstubAllGlobals();
	execute.mockReset();
});

it('uses the official GitHub CLI for release checks when custom HTTP clients receive 403', async () => {
	const fetch = vi.fn(async () => new Response('Forbidden', { status: 403 }));
	vi.stubGlobal('fetch', fetch);
	const commit = 'a'.repeat(40);
	const token = 'dummy-sensitive-token';
	execute.mockImplementation((_tool, args, _options, callback) => {
		callback(null, JSON.stringify(args[1].endsWith('/commits/v0.1.0') ? { sha: commit } : { private: false }), '');
	});
	await expect(readReleaseTarget('v0.1.0', commit, token)).resolves.toBe(commit);
	expect(fetch).not.toHaveBeenCalled();
	expect(execute).toHaveBeenCalledTimes(2);
	for (const [tool, args, options] of execute.mock.calls) {
		expect(tool).toBe('gh');
		expect(args).toContain('GET');
		expect(args).toContain('github.com');
		expect(args.join(' ')).not.toContain(token);
		expect(options.env.GH_TOKEN).toBe(token);
		expect(options.env.GH_DEBUG).toBe('');
		expect(options.timeout).toBe(30000);
	}
});

it('withholds credentials and raw CLI output when release API access fails', async () => {
	const token = 'dummy-sensitive-token';
	execute.mockImplementation((_tool, _args, _options, callback) => {
		callback(new Error(token), token, `gh: Resource not accessible by integration (HTTP 403) ${token}`);
	});
	const error = await readReleaseTarget('v0.1.0', 'a'.repeat(40), token).catch((error: unknown) => error);
	expect(error).toBeInstanceOf(Error);
	expect(String(error)).toContain('403');
	expect(String(error)).not.toContain(token);
});

it('requires a token before invoking GitHub CLI', async () => {
	await expect(readReleaseTarget('v0.1.0', 'a'.repeat(40), '')).rejects.toThrow('Missing GitHub release token');
	expect(execute).not.toHaveBeenCalled();
});

it('rejects malformed API output without including it in the error', async () => {
	execute.mockImplementation((_tool, _args, _options, callback) => {
		callback(null, 'dummy-sensitive-invalid-json', '');
	});
	const error = await readReleaseTarget('v0.1.0', 'a'.repeat(40), 'dummy-token').catch((error: unknown) => error);
	expect(String(error)).toContain('invalid JSON');
	expect(String(error)).not.toContain('dummy-sensitive');
});
