import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const data = await mkdtemp(join(tmpdir(), 'svnbox-app-updates-'));
const output = resolve('test-results');
const errors = [];
let instance;
let page;

async function call(action) {
	return page.evaluate((action) => window.svnbox.call('appUpdate', { action }), action);
}

async function navigate(action) {
	await instance.evaluate(({ BrowserWindow }, action) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', action), action);
}

try {
	await mkdir(output, { recursive: true });
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: data },
	});
	page = await instance.firstWindow();
	page.setDefaultTimeout(10000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForSelector('.sidebar');
	await instance.evaluate(({ app }) => app.focus({ steal: true }));
	const initial = await call('status');
	assert.match(initial.currentVersion, /^\d+\.\d+\.\d+$/);
	if (!process.env.SVNBOX_PACKAGED_APP) {
		assert.equal(initial.phase, 'disabled');
		await navigate('app-update');
		await page.getByText('开发模式下不检查应用更新。', { exact: true }).waitFor();
		assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true);
	} else {
		assert.equal(initial.phase, 'idle');
		const configuration = await instance.evaluate(async ({ app }) => {
			const updater = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`)('electron-updater').autoUpdater;
			globalThis.updateTest = { mode: 'current', checks: 0, downloads: 0, installs: 0, updater };
			updater.checkForUpdates = async () => {
				globalThis.updateTest.checks++;
				updater.emit('checking-for-update');
				if (globalThis.updateTest.mode === 'error') {
					const error = new Error('Isolated simulated network failure');
					updater.emit('error', error);
					throw error;
				}
				updater.emit(globalThis.updateTest.mode === 'current' ? 'update-not-available' : 'update-available', { version: '9.9.9' });
				return null;
			};
			updater.downloadUpdate = () => {
				globalThis.updateTest.downloads++;
				return new Promise((resolve) => {
					globalThis.updateTest.finish = () => {
						updater.emit('update-downloaded', { version: '9.9.9' });
						resolve([]);
					};
					updater.emit('download-progress', { percent: 37 });
				});
			};
			updater.quitAndInstall = () => {
				globalThis.updateTest.installs++;
				if (globalThis.updateTest.installs === 1) {
					updater.emit('error', new Error('Isolated simulated native installation error'));
				}
			};
			return {
				autoDownload: updater.autoDownload,
				autoInstallOnAppQuit: updater.autoInstallOnAppQuit,
				allowDowngrade: updater.allowDowngrade,
				allowPrerelease: updater.allowPrerelease,
				feed: await updater.configOnDisk.value,
			};
		});
		assert.deepEqual(configuration, {
			autoDownload: false,
			autoInstallOnAppQuit: false,
			allowDowngrade: false,
			allowPrerelease: false,
			feed: { provider: 'github', owner: 'svn-box', repo: 'svn-box', updaterCacheDirName: 'svnbox-updater' },
		});
		const menuLabels = await instance.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.map((item) => item.label));
		assert.deepEqual(menuLabels.slice(0, 2), ['关于仓盒', '检查更新']);
		await navigate('settings');
		await page.getByRole('tab', { name: '工具', exact: true }).click();
		await page.getByLabel('外部合并工具', { exact: true }).fill('/tmp/unsaved-update-test.app');
		await instance.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()
				.items[0].submenu.items.find((item) => item.label === '检查更新')
				.click(),
		);
		await page.getByText('已是最新版本', { exact: true }).waitFor();
		assert.equal(await page.getByRole('tab', { name: '通用设置', exact: true }).getAttribute('aria-selected'), 'true');
		await page.getByRole('tab', { name: '工具', exact: true }).click();
		assert.equal(await page.getByLabel('外部合并工具', { exact: true }).inputValue(), '/tmp/unsaved-update-test.app');
		await page.getByRole('tab', { name: '通用设置', exact: true }).click();
		await instance.evaluate(() => {
			globalThis.updateTest.mode = 'error';
		});
		await page.getByRole('button', { name: '检查更新', exact: true }).click();
		await page.getByText('暂时无法检查更新，请检查网络后重试。', { exact: true }).waitFor();
		await instance.evaluate(() => {
			globalThis.updateTest.mode = 'available';
		});
		await page.getByRole('button', { name: '检查更新', exact: true }).click();
		await page.getByText('发现新版本 9.9.9', { exact: true }).waitFor();
		assert.equal(await instance.evaluate(() => globalThis.updateTest.downloads), 0);
		await page.screenshot({ path: join(output, 'app-update-available.png') });
		await page.getByRole('button', { name: '下载更新', exact: true }).click();
		await page.waitForFunction(() => document.querySelector('[aria-label="应用更新下载进度"]')?.value === 37);
		await page.getByRole('button', { name: '关闭', exact: true }).first().click();
		await navigate('settings');
		await page.waitForFunction(() => document.querySelector('[aria-label="应用更新下载进度"]')?.value === 37);
		await instance.evaluate(() => globalThis.updateTest.finish());
		await page.getByRole('button', { name: '重启并安装', exact: true }).waitFor();
		await page.getByRole('button', { name: '灰色', exact: true }).click();
		await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
		await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 680));
		await page.locator('.settings-app-update').scrollIntoViewIfNeeded();
		assert.equal(await page.locator('.settings-page').evaluate((element) => element.scrollWidth > element.clientWidth), false);
		await page.screenshot({ path: join(output, 'app-update-ready-dark.png') });
		await page.getByRole('button', { name: '重启并安装', exact: true }).click();
		await page.getByText('更新安装未完成，请重试或从发布页下载安装。', { exact: true }).waitFor();
		await page.getByRole('button', { name: '重启并安装', exact: true }).click();
		await page.getByText('正在准备安装更新…', { exact: true }).waitFor();
		assert.equal((await call('status')).phase, 'installing');
		assert.deepEqual(
			await instance.evaluate(() => ({ checks: globalThis.updateTest.checks, downloads: globalThis.updateTest.downloads, installs: globalThis.updateTest.installs })),
			{ checks: 3, downloads: 1, installs: 2 },
		);
	}
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({ result: 'passed', packaged: !!process.env.SVNBOX_PACKAGED_APP, source: 'isolated simulated updater; no network downloads or application replacement' }),
	);
} catch (error) {
	await page?.screenshot({ path: join(output, 'app-update-failure.png') }).catch(() => {});
	throw error;
} finally {
	await instance?.close().catch(() => {});
	await rm(data, { recursive: true, force: true });
}
