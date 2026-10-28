import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
// @ts-expect-error Release scripts run directly in Node.js.
import { readReleaseMetadata, verifyReleaseFiles, writeReleaseFiles } from '../scripts/release-metadata.mjs';
// @ts-expect-error Release scripts run directly in Node.js.
import { verifyUpdateSignature } from '../scripts/update-signature.mjs';
// @ts-expect-error Release scripts run directly in Node.js.
import { publishRelease } from '../scripts/github-release.mjs';

const execute = promisify(execFile);
let temporary: string;
let publicKey: string;
let signature: string;
let version: string;
let newerVersion: string;
const contents = Buffer.from('Independent Tauri CLI interoperability fixture.');

async function cli(arguments_: string[], env = process.env) {
	try {
		await execute(process.execPath, [resolve('node_modules/@tauri-apps/cli/tauri.js'), ...arguments_], { env, timeout: 30000 });
	} catch {
		throw new Error('Tauri interoperability fixture could not be generated; private output withheld.');
	}
}

beforeAll(async () => {
	version = (await readReleaseMetadata()).version;
	const [major, minor, patch] = version.split('.').map(Number);
	newerVersion = `${major}.${minor}.${patch + 1}`;
	temporary = await mkdtemp(join(tmpdir(), 'svnbox-signature-test-'));
	const keyPath = join(temporary, 'throwaway.key');
	await cli(['signer', 'generate', '--ci', '--password', '', '--write-keys', keyPath]);
	publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
	const archive = join(temporary, 'fixture.app.tar.gz');
	await writeFile(archive, contents);
	await cli(['signer', 'sign', '--app-version', version, archive], {
		...process.env,
		TAURI_SIGNING_PRIVATE_KEY: await readFile(keyPath, 'utf8'),
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
	});
	signature = (await readFile(`${archive}.sig`, 'utf8')).trim();
});

afterAll(async () => {
	if (temporary) {
		await rm(temporary, { recursive: true, force: true });
	}
});

describe('Tauri updater release integrity', () => {
	it('accepts a version-bound signature produced by the installed Tauri CLI', () => {
		expect(() => verifyUpdateSignature(contents, signature, publicKey, version)).not.toThrow();
	});

	it('rejects changed archive bytes and a newer version paired with an old archive', () => {
		expect(() => verifyUpdateSignature(Buffer.concat([contents, Buffer.from('tampered')]), signature, publicKey, version)).toThrow(/signature/);
		expect(() => verifyUpdateSignature(contents, signature, publicKey, newerVersion)).toThrow(/Signed version/);
	});

	it('rejects edits to the signed version in the trusted comment', () => {
		const edited = Buffer.from(Buffer.from(signature, 'base64').toString().replace(`version:${version}`, `version:${newerVersion}`)).toString('base64');
		expect(() => verifyUpdateSignature(contents, edited, publicKey, newerVersion)).toThrow(/trusted comment/);
	});

	it('checks the update signature even after an attacker recalculates the manifest and all checksums', async () => {
		const metadata = await readReleaseMetadata();
		const directory = join(temporary, 'distribution');
		await mkdir(directory);
		metadata.config.plugins.updater.pubkey = publicKey;
		await writeFile(join(directory, metadata.archives[0]), 'DMG fixture');
		await writeFile(join(directory, metadata.archives[1]), contents);
		await writeFile(join(directory, metadata.archives[2]), signature);
		await writeReleaseFiles(metadata, directory, 'a'.repeat(40), 'ABCDEFGHIJ');
		await expect(verifyReleaseFiles(metadata, directory)).resolves.toMatchObject({ version });
		await writeFile(join(directory, metadata.archives[1]), 'replaced archive');
		await writeReleaseFiles(metadata, directory, 'a'.repeat(40), 'ABCDEFGHIJ');
		await expect(verifyReleaseFiles(metadata, directory)).rejects.toThrow(/signature/);
	});

	it('refuses mismatched tags and prevents unsigned previews from reaching GitHub', async () => {
		await expect(readReleaseMetadata(resolve('.'), { tag: `v${newerVersion}` })).rejects.toThrow(/tag/);
		let called = false;
		await expect(
			publishRelease({ unsigned: true }, 'a'.repeat(40), 'svn-box/svn-box', 'unused', () => {
				called = true;
			}),
		).rejects.toThrow(/Unsigned/);
		expect(called).toBe(false);
	});
});
