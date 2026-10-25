import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-themes-')));
const repository = join(root, 'Repository');
const data = join(root, 'data');
const copies = ['仓盒客户端', '资源与设计系统'].map((name) => join(root, name));
const output = resolve('test-results');
const svn = (...args) => execFileSync('/opt/homebrew/bin/svn', args, { encoding: 'utf8' });
const choices = [
	['light', '白色', false],
	['dark', '灰色', true],
	['ocean', '海湾蓝', false],
	['mint', '薄荷绿', false],
	['iris', '鸢尾紫', true],
	['sunset', '落日橙', false],
];
const checks = [];
const errors = [];
const palettes = [];
let instance;
let page;

async function call(method, input) {
	return page.evaluate(({ method, input }) => window.svnbox.call(method, input), { method, input });
}

async function launch() {
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: data },
	});
	page = await instance.firstWindow();
	page.setDefaultTimeout(12000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForSelector('.welcome, .project-header');
}

async function settings() {
	await page.getByRole('button', { name: /^设置/ }).click();
	await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
}

async function screenshot(name) {
	await page.screenshot({ path: join(output, name), animations: 'disabled' });
}

try {
	await mkdir(output, { recursive: true });
	execFileSync('/opt/homebrew/bin/svnadmin', ['create', repository]);
	const url = `${pathToFileURL(repository).href}/trunk`;
	svn('mkdir', url, '-m', '主题验证临时仓库');
	svn('checkout', url, copies[0]);
	await mkdir(join(copies[0], 'src'));
	await writeFile(join(copies[0], 'src/工作空间.ts'), "export const theme = 'white';\nexport const projects = 1;\n");
	await writeFile(join(copies[0], 'README.md'), '# 仓盒\n轻松管理 SVN 项目。\n');
	svn('add', `${copies[0]}/src@`, `${copies[0]}/README.md@`);
	svn('commit', `${copies[0]}@`, '-m', '准备主题验证数据');
	svn('checkout', url, copies[1]);
	await writeFile(join(copies[0], 'src/工作空间.ts'), "export const theme = 'ocean';\nexport const projects = 2;\nexport const workspace = '仓盒';\n");
	await writeFile(join(copies[0], 'README.md'), '# 仓盒 · svnbox\n用喜欢的色彩，让工作空间更轻松。\n');
	svn('propset', 'svn:keywords', 'Id', `${copies[0]}/README.md@`);
	await writeFile(join(copies[0], '配色说明.txt'), '未受控文件\n');
	await launch();
	for (const path of copies) {
		await call('addWorkingCopy', { path });
	}
	let state = await call('state');
	const copy = state.workingCopies.find((copy) => copy.path === copies[0]);
	await call('activate', { wcId: copy.id });
	await call('session', { wcId: copy.id, patch: { draft: '切换主题仍保留的提交说明', currentPath: 'src/工作空间.ts', expanded: ['.', 'src'] } });
	await page.reload();
	await page.waitForSelector('.diff-view');
	await page.waitForFunction(() => document.querySelector('.diff-view')?.textContent?.includes('ocean'));
	for (const [id, label, dark] of choices) {
		await settings();
		const dialog = page.getByRole('dialog', { name: '设置', exact: true });
		assert.equal(await dialog.locator('.settings-themes > button').count(), 6);
		assert.equal(await dialog.getByRole('button', { name: '跟随系统', exact: true }).count(), 0);
		const button = dialog.getByRole('button', { name: label, exact: true });
		await button.click();
		await page.waitForFunction(({ id, dark }) => document.documentElement.dataset.theme === id && document.documentElement.classList.contains('dark') === dark, { id, dark });
		await page.waitForFunction((button) => !button.disabled && button.getAttribute('aria-pressed') === 'true', await button.elementHandle());
		assert.equal((await call('state')).settings.theme, id);
		assert.equal(await instance.evaluate(({ nativeTheme }) => nativeTheme.themeSource), dark ? 'dark' : 'light');
		await screenshot(`theme-${id}-settings.png`);
		await dialog.screenshot({ path: join(output, `theme-${id}-picker.png`), animations: 'disabled' });
		const previewColors = await dialog.locator('.theme-preview').evaluateAll((elements) => elements.map((element) => getComputedStyle(element).backgroundColor));
		assert.equal(new Set(previewColors).size, 6, '每张卡片在任一主题下显示自己的配色');
		await page.emulateMedia({ contrast: 'more' });
		assert.equal(
			await page.evaluate(() => {
				const style = getComputedStyle(document.documentElement);
				return style.getPropertyValue('--border').trim() === style.getPropertyValue('--border-input').trim();
			}),
			true,
			'提高对比度适用于每套主题',
		);
		await page.emulateMedia({ contrast: 'no-preference' });
		const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sidebar'));
		await page.emulateMedia({ colorScheme: dark ? 'light' : 'dark' });
		assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sidebar')), before, '系统外观不覆盖用户的配色');
		const geometry = await dialog.evaluate((element) => {
			const panel = element.querySelector('.settings-page');
			const cards = [...element.querySelectorAll('.settings-themes > button')].map((card) => card.getBoundingClientRect());
			const bounds = panel.getBoundingClientRect();
			return { overflow: panel.scrollWidth > panel.clientWidth, allVisible: cards.every((card) => card.top >= bounds.top && card.bottom <= bounds.bottom) };
		});
		assert.equal(geometry.overflow, false);
		assert.equal(geometry.allVisible, true, '默认窗口内六套主题完整可见');
		await dialog.getByRole('button', { name: '关闭', exact: true }).first().click();
		await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
		assert.equal(await page.locator('.diff-view').count(), 1);
		palettes.push({ id, label, dark, sidebar: before.trim() });
		await screenshot(`theme-${id}-workspace.png`);
		await page.getByRole('button', { name: '工作副本操作', exact: true }).click();
		await page.getByRole('menuitem', { name: '查询整个工作副本历史', exact: true }).hover();
		await screenshot(`theme-${id}-menu.png`);
		await page.keyboard.press('Escape');
	}
	checks.push('六套主题真实选择/自动保存、原生窗口明暗、预览卡片不串色、文件与Diff完整切换', '系统明暗不改变所选配色、菜单和选中态随主题更新');
	await page.getByRole('button', { name: '刷新本地状态', exact: true }).click();
	await page.locator('[data-sonner-toast]').filter({ hasText: '本地状态已刷新' }).waitFor();
	await screenshot('theme-sunset-toast.png');
	await settings();
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 680));
	assert.equal(await page.locator('.settings-page').evaluate((element) => element.scrollWidth > element.clientWidth), false);
	await page.getByRole('button', { name: '鸢尾紫', exact: true }).scrollIntoViewIfNeeded();
	await page.getByRole('button', { name: '鸢尾紫', exact: true }).focus();
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.documentElement.dataset.theme === 'iris');
	await screenshot('theme-small-window.png');
	await instance.close();
	instance = undefined;
	await launch();
	await page.waitForFunction(() => document.documentElement.dataset.theme === 'iris');
	state = await call('state');
	assert.equal(state.settings.theme, 'iris');
	assert.equal(state.sessions[copy.id].draft, '切换主题仍保留的提交说明');
	await settings();
	assert.equal(await page.getByRole('button', { name: '鸢尾紫', exact: true }).getAttribute('aria-pressed'), 'true');
	checks.push('Toast、小窗口、键盘选择主题、重启保留主题和副本草稿');
	await instance.close();
	instance = undefined;
	const legacy = JSON.parse(await readFile(join(data, 'workspace.json'), 'utf8'));
	legacy.settings.theme = 'system';
	await writeFile(join(data, 'workspace.json'), JSON.stringify(legacy));
	await launch();
	await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
	assert.equal((await call('state')).settings.theme, 'light');
	checks.push('旧跟随系统配置安全迁移为白色');
	assert.deepEqual(errors, []);
	const report = { result: 'passed', checks, palettes, rendererErrors: errors };
	await writeFile(join(output, 'themes-verification.json'), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	await page?.screenshot({ path: join(output, 'themes-ui-failure.png'), animations: 'disabled' }).catch(() => {});
	throw error;
} finally {
	await instance?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
