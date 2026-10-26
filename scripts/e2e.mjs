import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-startup-')));
const errors = [];
let instance;
let page;
try {
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: root },
	});
	page = await instance.firstWindow();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.locator('.welcome').waitFor();
	const detection = await page.evaluate(() => window.svnbox.call('detect', {}));
	assert.equal(detection.ok, true, detection.error || 'Bundled SVN could not start');
	assert.match(detection.version, /^1\./);
	if (process.env.SVNBOX_PACKAGED_APP) {
		assert.ok(detection.path.startsWith(resolve(process.env.SVNBOX_PACKAGED_APP, '../../Resources/svn/')), 'The packaged app must use its bundled SVN');
	}
	const security = await instance.evaluate(({ BrowserWindow }) => {
		const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
		return { sandbox: preferences.sandbox, isolation: preferences.contextIsolation, node: preferences.nodeIntegration };
	});
	assert.deepEqual(security, { sandbox: true, isolation: true, node: false });
	assert.deepEqual(errors, []);
	console.log('Smoke passed: packaged app startup, renderer/preload IPC, bundled SVN and Electron isolation.');
} catch (error) {
	await mkdir(resolve('test-results'), { recursive: true });
	await page?.screenshot({ path: resolve('test-results/smoke-failure.png') }).catch(() => {});
	console.error(error);
	process.exitCode = 1;
} finally {
	await instance?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
