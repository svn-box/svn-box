import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'svnbox-settings-'));
const errors = [];
let instance;
let page;

async function launch() {
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: root },
	});
	page = await instance.firstWindow();
	page.setDefaultTimeout(10000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForSelector('.welcome');
	await instance.evaluate(({ app, BrowserWindow }) => {
		app.focus({ steal: true });
		BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'settings');
	});
	await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
}

async function call(method, input) {
	return page.evaluate(({ method, input }) => window.svnbox.call(method, input), { method, input });
}

async function chooseTheme(theme, label) {
	const button = page.getByRole('button', { name: label, exact: true });
	await button.click();
	await page.waitForFunction(async (theme) => (await window.svnbox.call('state')).settings.theme === theme, theme);
	await page.waitForFunction((button) => button.getAttribute('aria-pressed') === 'true' && !button.disabled, await button.elementHandle());
	const dark = theme === 'dark' || theme === 'iris';
	await page.waitForFunction((dark) => document.documentElement.classList.contains('dark') === dark, dark);
}

async function checkBounds() {
	const bounds = await page.locator('.settings-dialog').evaluate((dialog) => {
		const rect = dialog.getBoundingClientRect();
		const panel = dialog.querySelector('[role="tabpanel"]');
		return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, overflow: panel.scrollWidth - panel.clientWidth };
	});
	assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, JSON.stringify(bounds));
	assert.equal(bounds.overflow, 0, '设置内容不应出现横向溢出');
}

try {
	await launch();
	const dialog = page.getByRole('dialog', { name: '设置', exact: true });
	const general = dialog.getByRole('tab', { name: '通用设置', exact: true });
	const tools = dialog.getByRole('tab', { name: '工具', exact: true });
	const updates = dialog.getByRole('tab', { name: '应用更新', exact: true });
	assert.equal(await general.getAttribute('aria-selected'), 'true');
	assert.equal(await dialog.getByRole('combobox', { name: '界面语言', exact: true }).isDisabled(), false);
	assert.equal(await dialog.getByLabel('可执行文件路径').count(), 0);
	assert.equal(await dialog.locator('input[type="password"]').count(), 0);
	await chooseTheme('light', '白色');
	await checkBounds();
	await page.screenshot({ animations: 'disabled', path: resolve('test-results/settings-general-light.png') });
	assert.equal(await dialog.getByRole('button', { name: '跟随系统', exact: true }).count(), 0);
	assert.equal(await dialog.locator('.settings-themes > button').count(), 6);
	await page.emulateMedia({ colorScheme: 'dark' });
	assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), false);
	await chooseTheme('dark', '灰色');
	await page.emulateMedia({ colorScheme: 'light' });
	assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);
	await page.screenshot({ animations: 'disabled', path: resolve('test-results/settings-general-dark.png') });
	await general.focus();
	await page.keyboard.press('End');
	assert.equal(await updates.getAttribute('aria-selected'), 'true');
	await page.keyboard.press('ArrowUp');
	assert.equal(await tools.getAttribute('aria-selected'), 'true');
	assert.equal(await tools.evaluate((button) => button === document.activeElement), true);
	const detected = await call('detect', {});
	assert.equal(detected.ok, true);
	const path = dialog.getByLabel('可执行文件路径', { exact: true });
	await path.fill('/tmp/svnbox-settings-tool-that-does-not-exist');
	await dialog.getByLabel('外部合并工具', { exact: true }).fill('/Applications/未保存的合并工具.app');
	await tools.focus();
	await page.keyboard.press('Home');
	assert.equal(await general.getAttribute('aria-selected'), 'true');
	await general.press('ArrowDown');
	assert.equal(await path.inputValue(), '/tmp/svnbox-settings-tool-that-does-not-exist');
	assert.equal(await dialog.getByLabel('外部合并工具', { exact: true }).inputValue(), '/Applications/未保存的合并工具.app');
	const original = (await call('state')).settings;
	await dialog.getByRole('button', { name: '保存并检测', exact: true }).click();
	await dialog.getByRole('alert').waitFor();
	assert.deepEqual((await call('state')).settings, original, '无效工具配置不能覆盖已保存的配置');
	await path.fill(detected.path);
	await dialog.getByLabel('外部合并工具', { exact: true }).fill('');
	await dialog.getByRole('button', { name: '保存并检测', exact: true }).click();
	await page.locator('[data-sonner-toast]').filter({ hasText: '设置已保存' }).waitFor();
	await page
		.locator('.settings-detection.good')
		.filter({ hasText: `Subversion ${detected.version}` })
		.waitFor();
	assert.equal((await call('state')).settings.svnPath, detected.path);
	await checkBounds();
	await page.screenshot({ animations: 'disabled', path: resolve('test-results/settings-tools-dark.png') });
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 680));
	await checkBounds();
	await tools.click();
	await page.keyboard.press('Escape');
	await dialog.waitFor({ state: 'hidden' });
	await instance.close();
	await launch();
	assert.equal(await page.getByRole('button', { name: '灰色', exact: true }).getAttribute('aria-pressed'), 'true');
	await page.getByRole('tab', { name: '工具', exact: true }).click();
	assert.equal(await page.getByLabel('可执行文件路径', { exact: true }).inputValue(), detected.path);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify(
			{
				result: 'passed',
				checks: [
					'通用/工具/应用更新分页与键盘导航',
					'语言能力如实显示',
					'白色/灰色及六套外观、固定配色即时保存',
					'分页保留工具输入',
					'无效工具配置保留原值',
					'真实 SVN 检测',
					'小窗口无溢出',
					'重启恢复主题与工具配置',
				],
			},
			null,
			2,
		),
	);
} catch (error) {
	await page?.screenshot({ animations: 'disabled', path: resolve('test-results/settings-ui-failure.png') }).catch(() => {});
	throw error;
} finally {
	await instance?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
