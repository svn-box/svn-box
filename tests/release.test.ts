import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { archiveNames, fileChecksum, previewMode, readReleaseMetadata, RELEASE_REPOSITORY, verifyReleaseFiles, type ReleaseMetadata } from '../scripts/release-metadata.ts';
import { ensureReleaseAbsent, findRelease, readReleaseTarget, type RepositoryRelease } from '../scripts/github-release-api.ts';
import { publishRelease } from '../scripts/github-release.ts';
import { buildEnvironment, releaseCommand, requireSigningEnvironment } from '../scripts/release-mac.ts';

const temporary: string[] = [];
const token = 'dummy-release-token';
const commit = 'a'.repeat(40);

afterEach(async () => {
	vi.unstubAllGlobals();
	await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; metadata: ReleaseMetadata; files: string[] }> {
	const root = await mkdtemp(join(tmpdir(), 'svnbox-release-'));
	temporary.push(root);
	const version = '0.1.0';
	await writeFile(join(root, 'package.json'), JSON.stringify({ version }));
	await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
	await mkdir(join(root, 'release-notes'));
	await writeFile(join(root, 'release-notes/0.1.0.md'), '# svnbox 0.1.0\n\n- Initial release.\n');
	const metadata = await readReleaseMetadata(root, `v${version}`);
	await mkdir(metadata.directory, { recursive: true });
	const checksums: string[] = [];
	for (const name of archiveNames(version)) {
		const path = join(metadata.directory, name);
		await writeFile(path, `test archive ${name}`);
		checksums.push(`${await fileChecksum(path)}  ${name}`);
	}
	await writeFile(join(metadata.directory, 'SHA256SUMS'), checksums.join('\n') + '\n');
	return { root, metadata, files: await verifyReleaseFiles(metadata) };
}

function mockResponses(values: Response[]): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			const response = values.shift();
			if (!response) {
				throw new Error('Unexpected release API request.');
			}
			return response;
		}),
	);
}

function targetResponses(sha = commit): Response[] {
	return [Response.json({ private: false }), Response.json({ sha })];
}

async function draft(metadata: ReleaseMetadata, files: string[]): Promise<RepositoryRelease> {
	return {
		tag_name: metadata.tag,
		draft: true,
		prerelease: false,
		assets: await Promise.all(
			files.map(async (path) => ({ name: basename(path), size: (await readFile(path)).length, state: 'uploaded', digest: `sha256:${await fileChecksum(path)}` })),
		),
	};
}

describe('0.1.0 release invariants', () => {
	it('checks the source version, lockfile, tag and real nonempty notes together', async () => {
		const { root, metadata } = await fixture();
		await expect(readReleaseMetadata(root, 'v0.2.0')).rejects.toThrow('does not match');
		await expect(readReleaseMetadata(root, 'v../../escape')).rejects.toThrow('does not match');
		await writeFile(metadata.notes, ' \n');
		await expect(readReleaseMetadata(root)).rejects.toThrow('nonempty');
		await writeFile(metadata.notes, '# Release');
		await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version: '0.2.0', packages: { '': { version: '0.1.0' } } }));
		await expect(readReleaseMetadata(root)).rejects.toThrow('do not match');
		await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.0-beta' }));
		await expect(readReleaseMetadata(root)).rejects.toThrow('stable');
	});

	it('keeps preview output separate and disallows unsigned version-tag releases', async () => {
		const { root, metadata } = await fixture();
		expect((await readReleaseMetadata(root, undefined, true)).directory).toBe(join(root, 'release/preview/0.1.0/macos/arm64'));
		expect(metadata.directory).toBe(join(root, 'release/0.1.0/macos/arm64'));
		expect(previewMode(['--unsigned'], {})).toBe(true);
		expect(previewMode([], {})).toBe(false);
		expect(() => previewMode(['--unsigned'], { GITHUB_REF_TYPE: 'tag' })).toThrow('cannot');
		expect(() => previewMode(['--unknown'], {})).toThrow('Only');
		expect(() => requireSigningEnvironment({})).toThrow('never falls back');
		expect(() => requireSigningEnvironment({ APPLE_ID: 'dummy', APPLE_TEAM_ID: 'bad', APPLE_APP_SPECIFIC_PASSWORD: 'dummy', CSC_KEYCHAIN: '/tmp/dummy' })).toThrow('ten');
	});

	it('rejects corrupted archives, unexpected files and symlink substitutions', async () => {
		const { metadata } = await fixture();
		const archive = join(metadata.directory, archiveNames(metadata.version)[0]);
		const original = await readFile(archive);
		await writeFile(archive, 'corruption');
		await expect(verifyReleaseFiles(metadata)).rejects.toThrow('SHA256');
		await writeFile(archive, original);
		const extra = join(metadata.directory, '.env');
		await writeFile(extra, 'dummy');
		await expect(verifyReleaseFiles(metadata)).rejects.toThrow('only');
		await rm(extra);
		await rm(archive);
		await symlink(join(metadata.directory, 'SHA256SUMS'), archive);
		await expect(verifyReleaseFiles(metadata)).rejects.toThrow('Invalid');
	});

	it('does not pass signing or publishing credentials to build and UI children', () => {
		const cleaned = buildEnvironment({
			APPLE_ID: 'dummy',
			APPLE_TEAM_ID: 'DUMMY00000',
			APPLE_APP_SPECIFIC_PASSWORD: 'dummy',
			CSC_KEYCHAIN: 'dummy',
			CSC_LINK: 'dummy',
			CSC_KEY_PASSWORD: 'dummy',
			GH_TOKEN: 'dummy',
			GITHUB_TOKEN: 'dummy',
			BUILD_CERTIFICATE_BASE64: 'dummy',
			P12_PASSWORD: 'dummy',
			SVNBOX_DATA_DIR: '/tmp/isolated-profile',
			PATH: '/bin',
		});
		expect(cleaned).toEqual({ SVNBOX_DATA_DIR: '/tmp/isolated-profile', PATH: '/bin' });
	});

	it('does not expose failed command arguments or output containing credentials', async () => {
		const secret = 'dummy-sensitive-value';
		const error = await releaseCommand(process.execPath, ['-e', `process.stdout.write('${secret}'); process.stderr.write('${secret}'); process.exit(1)`]).catch(
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain(secret);
	});

	it('requires authentication, a public repository and the exact pushed tag commit', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		await expect(readReleaseTarget('v0.1.0', commit, '')).rejects.toThrow('token');
		expect(fetch).not.toHaveBeenCalled();
		mockResponses([Response.json({ private: true })]);
		await expect(readReleaseTarget('v0.1.0', commit, token)).rejects.toThrow('public');
		mockResponses(targetResponses('b'.repeat(40)));
		await expect(readReleaseTarget('v0.1.0', commit, token)).rejects.toThrow('no longer matches');
		mockResponses([Response.json({ private: false }), new Response(undefined, { status: 404 })]);
		await expect(readReleaseTarget('v0.1.0', commit, token)).rejects.toThrow('404');
	});

	it('finds existing drafts across pages and treats API errors as failures', async () => {
		const release = { tag_name: 'v0.1.0', draft: true, prerelease: false, assets: [] };
		mockResponses([Response.json(Array.from({ length: 100 }, () => ({ ...release, tag_name: 'v9.9.9' }))), Response.json([release])]);
		expect((await findRelease('v0.1.0', token))?.draft).toBe(true);
		mockResponses([Response.json([release])]);
		await expect(ensureReleaseAbsent('v0.1.0', token)).rejects.toThrow('already');
		mockResponses([new Response(undefined, { status: 403 })]);
		await expect(ensureReleaseAbsent('v0.1.0', token)).rejects.toThrow('403');
	});

	it('uploads only a draft and publishes after validating every uploaded digest and tag again', async () => {
		const { metadata, files } = await fixture();
		mockResponses([...targetResponses(), Response.json([]), Response.json([await draft(metadata, files)]), ...targetResponses()]);
		const commands: string[][] = [];
		await publishRelease(metadata, commit, token, async (args) => {
			commands.push(args);
		});
		expect(commands).toHaveLength(2);
		expect(commands[0]).toContain('--draft');
		expect(commands[0]).toContain(RELEASE_REPOSITORY);
		expect(commands[0]).toContain(commit);
		expect(commands[0]).toContain('--notes-file');
		expect(commands[1]).toContain('--draft=false');
	});

	it('leaves the draft unpublished if assets are incomplete, corrupted or unexpected', async () => {
		const { metadata, files } = await fixture();
		for (const variant of ['size', 'state', 'digest', 'missing', 'extra', 'public']) {
			const release = await draft(metadata, files);
			if (variant === 'size') {
				release.assets[0].size++;
			}
			if (variant === 'state') {
				release.assets[0].state = 'new';
			}
			if (variant === 'digest') {
				release.assets[0].digest = `sha256:${'0'.repeat(64)}`;
			}
			if (variant === 'missing') {
				release.assets.pop();
			}
			if (variant === 'extra') {
				release.assets.push({ ...release.assets[0], name: 'unexpected.env' });
			}
			if (variant === 'public') {
				release.draft = false;
			}
			mockResponses([...targetResponses(), Response.json([]), Response.json([release])]);
			const commands: string[][] = [];
			await expect(
				publishRelease(metadata, commit, token, async (args) => {
					commands.push(args);
				}),
			).rejects.toThrow();
			expect(commands).toHaveLength(1);
			expect(commands[0]).toContain('--draft');
		}
	});

	it('does not publish if the tag moved during upload', async () => {
		const { metadata, files } = await fixture();
		mockResponses([...targetResponses(), Response.json([]), Response.json([await draft(metadata, files)]), ...targetResponses('b'.repeat(40))]);
		const commands: string[][] = [];
		await expect(
			publishRelease(metadata, commit, token, async (args) => {
				commands.push(args);
			}),
		).rejects.toThrow('no longer matches');
		expect(commands).toHaveLength(1);
	});

	it('refuses to overwrite a release or upload corrupt local files', async () => {
		const { metadata, files } = await fixture();
		mockResponses([...targetResponses(), Response.json([await draft(metadata, files)])]);
		const run = vi.fn();
		await expect(publishRelease(metadata, commit, token, run)).rejects.toThrow('already');
		expect(run).not.toHaveBeenCalled();
		await writeFile(files[1], 'changed bytes');
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		await expect(publishRelease(metadata, commit, token, run)).rejects.toThrow('SHA256');
		expect(fetch).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});
});
