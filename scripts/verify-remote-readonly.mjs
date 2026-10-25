import { _electron as electron } from 'playwright';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const url = process.env.SVNBOX_VERIFY_URL;
assert.ok(url && ['svn:', 'https:', 'http:'].includes(new URL(url).protocol), 'Set SVNBOX_VERIFY_URL to the read-only verification target');
assert.equal(new URL(url).password, '', 'Passwords must not be included in URLs');
const executablePath = process.env.SVNBOX_PACKAGED_APP;
assert.ok(executablePath, 'Set SVNBOX_PACKAGED_APP to the packaged executable');
const source = join(homedir(), 'Library/Application Support/svnbox');
const temporary = await mkdtemp(join(tmpdir(), 'svnbox-readonly-check-'));
await chmod(temporary, 0o700);
let instance;

try {
	const state = JSON.parse(await readFile(join(source, 'workspace.json'), 'utf8'));
	// Isolate UI state and writes; only the explicit remote list is requested.
	state.workingCopies = [];
	state.sessions = {};
	delete state.activeId;
	state.settings.svnPath = '';
	await writeFile(join(temporary, 'workspace.json'), JSON.stringify(state), { mode: 0o600 });
	await copyFile(join(source, 'credentials.enc.json'), join(temporary, 'credentials.enc.json'));
	await chmod(join(temporary, 'credentials.enc.json'), 0o600);
	instance = await electron.launch({ executablePath, args: [], env: { ...process.env, SVNBOX_DATA_DIR: temporary } });
	const page = await instance.firstWindow();
	await page.waitForFunction(() => !!window.svnbox);
	const result = await page.evaluate(async (url) => {
		const start = Date.now();
		try {
			const detection = await window.svnbox.call('detect', {});
			const entries = await window.svnbox.call('list', { url });
			return {
				result: 'passed',
				elapsedMs: Date.now() - start,
				bundledRuntime: detection.path.includes('/Contents/Resources/svn/bin/svn'),
				version: detection.version,
				entryCount: entries.length,
				directoryCount: entries.filter((entry) => entry.kind === 'dir').length,
			};
		} catch (error) {
			return { result: 'failed', elapsedMs: Date.now() - start, kind: error.kind, message: error.message };
		}
	}, url);
	await mkdir(resolve('test-results'), { recursive: true });
	await writeFile(resolve('test-results/transport-remote-readonly.json'), JSON.stringify(result, null, 2) + '\n');
	assert.equal(result.result, 'passed', JSON.stringify(result));
	assert.equal(result.bundledRuntime, true);
	console.log(JSON.stringify(result));
} finally {
	await instance?.close();
	await rm(temporary, { recursive: true, force: true });
}
