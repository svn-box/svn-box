import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-e2e-')));
const svn = (...args) => execFileSync('/opt/homebrew/bin/svn', args, { encoding: 'utf8' });
const repository = join(root, 'test-repository');
execFileSync('/opt/homebrew/bin/svnadmin', ['create', repository]);
const url = pathToFileURL(repository).href;
svn('mkdir', `${url}/trunk`, '-m', '初始化仓库');
const a = join(root, '仓盒应用');
const b = join(root, '设计系统');
svn('checkout', `${url}/trunk`, a);
await mkdir(join(a, 'src'));
await writeFile(join(a, 'src/中文 @ 文件.ts'), "export const greeting = '你好，仓盒';\nexport const version = 1;\n");
await writeFile(join(a, 'README.md'), '# svnbox\n\n一个清晰的 SVN 工作空间。\n');
await writeFile(join(a, 'src/app.ts'), 'export const app = { name: "svnbox", theme: "system" };\n');
svn('add', `${a}/src@`, `${a}/README.md@`);
svn('commit', `${a}@`, '-m', 'feat: 建立仓盒的项目基础');
svn('checkout', `${url}/trunk`, b);
await writeFile(join(a, 'src/中文 @ 文件.ts'), "export const greeting = '你好，仓盒';\nexport const version = 2;\nexport const workspace = '独立上下文';\n");
await writeFile(join(a, 'src/app.ts'), 'export const app = { name: "svnbox", theme: "dark", persist: true };\n');
await writeFile(join(a, 'README.md'), '# svnbox · 仓盒\n\n一个清晰的 SVN 工作空间。\n\n每个工作副本都有自己的提交草稿。\n');
svn('propset', 'svn:keywords', 'Id', `${a}/README.md@`);
await writeFile(join(a, '.env.local'), 'DEMO=true\n');
await writeFile(join(b, 'README.md'), '# 设计系统\n\n设计变量与组件规范。\n');
const data = join(root, 'data');
let desktop;
const errors = [];
let fileMergeVerified = false;
async function launch() {
	const instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: data },
	});
	const page = await instance.firstWindow();
	page.setDefaultTimeout(15000);
	await instance.evaluate(({ app }) => app.focus({ steal: true }));
	await page.bringToFront();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForFunction(() => !!window.svnbox);
	await page.waitForSelector('.welcome, .project-header');
	return { instance, page };
}
async function call(page, method, input) {
	return page.evaluate(async ({ method, input }) => window.svnbox.call(method, input), { method, input });
}
async function waitOperation(page, id) {
	const deadline = Date.now() + 30000;
	let operation;
	do {
		operation = (await call(page, 'operations')).find((op) => op.id === id);
		if (!['running', 'waiting'].includes(operation.state)) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	assert.equal(operation.state, 'success', JSON.stringify(operation));
}
try {
	desktop = await launch();
	const { page, instance } = desktop;
	await mkdir(resolve('test-results'), { recursive: true });
	await page.screenshot({ path: resolve('test-results/welcome.png') });
	await instance.evaluate(({ dialog }, a) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [a] });
	}, a);
	await page.getByRole('button', { name: '添加已有工作副本', exact: true }).click();
	await page.waitForSelector('.project-header');
	await page.waitForFunction(() => document.querySelector('.scan-time')?.textContent?.includes('本地扫描'));
	await instance.evaluate(({ dialog }, b) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [b] });
	}, b);
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'add'));
	await page.waitForFunction(() => document.querySelector('.project-heading h1')?.textContent?.includes('设计系统'));
	assert.equal(await page.locator('.diff-view').count(), 0);
	const state = await call(page, 'state');
	assert.equal(state.workingCopies.length, 2);
	const first = state.workingCopies.find((copy) => copy.path === a);
	const second = state.workingCopies.find((copy) => copy.path === b);
	await page.getByRole('button', { name: '仓盒应用 trunk · 本地工作副本', exact: false }).first().click();
	await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('中文 @');
	await page.getByRole('button', { name: '设计系统 trunk · 本地工作副本', exact: false }).first().click();
	assert.equal(await page.getByRole('textbox', { name: '搜索文件', exact: true }).inputValue(), '');
	await page.getByRole('button', { name: '仓盒应用 trunk · 本地工作副本', exact: false }).first().click();
	assert.equal(await page.getByRole('textbox', { name: '搜索文件', exact: true }).inputValue(), '中文 @');
	await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('');
	await page.getByRole('button', { name: '中文 @ 文件.ts', exact: false }).first().click();
	await page.waitForFunction(() => [...document.querySelectorAll('.diff-line code')].some((el) => el.textContent?.includes('version = 2')));
	await page.locator('.file-pane').focus();
	await page.keyboard.press('ArrowDown');
	await page.waitForFunction(() => document.querySelector('.details-panel h2')?.textContent === 'app.ts');
	await page.keyboard.press('ArrowUp');
	await page.waitForFunction(() => document.querySelector('.details-panel h2')?.textContent === '中文 @ 文件.ts');
	await page.keyboard.press('Shift+F10');
	await page.getByRole('menuitem', { name: '查看此路径历史', exact: true }).waitFor();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: '并排', exact: true }).click();
	await page.waitForSelector('.diff-line.split');
	await page.getByRole('button', { name: '统一', exact: true }).click();
	if (process.env.SVNBOX_TEST_FILEMERGE) {
		const windows = () =>
			JSON.parse(
				execFileSync(
					'/usr/bin/osascript',
					[
						'-l',
						'JavaScript',
						'-e',
						"ObjC.import('Foundation'); ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['uint32', 'uint32']]); JSON.stringify(ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(0,0)).filter(w => w.kCGWindowOwnerName === 'FileMerge').map(w => ({id:w.kCGWindowNumber,title:w.kCGWindowName})))",
					],
					{ encoding: 'utf8' },
				),
			);
		const before = windows().map((window) => window.id);
		await page.getByRole('button', { name: 'FileMerge', exact: true }).click();
		await page.locator('[data-sonner-toast]').filter({ hasText: '已在 FileMerge 中打开比较' }).waitFor();
		let comparison;
		for (let attempt = 0; attempt < 50; attempt++) {
			comparison = windows().find((window) => !before.includes(window.id) && window.title?.includes('中文 @ 文件.BASE.ts') && window.title?.includes('WORKING'));
			if (comparison) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		assert.ok(comparison, 'FileMerge 必须实际打开 BASE / WORKING 比较窗口');
		execFileSync('/usr/sbin/screencapture', ['-x', '-o', `-l${comparison.id}`, resolve('test-results/filemerge.png')]);
		fileMergeVerified = true;
	}

	await page.getByRole('button', { name: /^提交…/ }).click();
	await page.getByRole('checkbox', { name: '提交 src/中文 @ 文件.ts', exact: true }).check();
	await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('修复多工作副本的上下文隔离');
	await page.getByRole('button', { name: '稍后继续', exact: true }).click();
	await page.getByRole('button', { name: '设计系统 trunk · 本地工作副本', exact: false }).first().click();
	await page.getByRole('button', { name: /^提交…/ }).click();
	await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('设计系统的独立草稿');
	await page.getByRole('button', { name: '稍后继续', exact: true }).click();
	await page.getByRole('button', { name: '仓盒应用 trunk · 本地工作副本', exact: false }).first().click();
	await page.waitForFunction(() => document.querySelector('.draft-preview')?.textContent === '修复多工作副本的上下文隔离');
	await page.waitForFunction(() => [...document.querySelectorAll('.diff-line code')].some((el) => el.textContent?.includes('version = 2')));
	await page.screenshot({ path: resolve('test-results/workspace-light.png') });
	await page.getByRole('button', { name: '继续编辑', exact: false }).click();
	await page.getByRole('button', { name: '审阅提交范围', exact: true }).click();
	await page.getByRole('heading', { name: '提交审阅', exact: true }).waitFor();
	assert.equal(await page.getByRole('dialog').count(), 1);
	await page.screenshot({ path: resolve('test-results/commit-review.png') });
	const commitFeedback = page.locator('[data-sonner-toast]').filter({ hasText: '提交变更完成' }).waitFor();
	await page.getByRole('button', { name: '确认提交', exact: true }).click();
	await commitFeedback;
	await page.waitForFunction(async () => (await window.svnbox.call('operations', undefined)).some((op) => op.label === '提交变更' && op.state === 'success'));
	assert.equal(await page.getByRole('dialog').count(), 0);
	assert.equal((await call(page, 'status', { wcId: first.id })).files.find((file) => file.path === 'README.md').item, 'modified');
	const update = await call(page, 'review', { wcId: second.id, action: 'update', paths: [] });
	await waitOperation(page, (await call(page, 'execute', { reviewId: update.id })).id);
	await page.getByRole('tab', { name: '历史', exact: true }).click();
	await page.getByRole('button', { name: /修复多工作副本的上下文隔离/ }).click();
	await page.waitForFunction(() => document.querySelector('.commit-message')?.textContent === '修复多工作副本的上下文隔离');
	await page
		.locator('.history-commit.selected')
		.getByRole('button', { name: /本次差异/ })
		.click();
	await page.waitForSelector('.history-inline-diff .diff-line');
	await page.screenshot({ path: resolve('test-results/history.png') });
	await page.getByRole('button', { name: /^提交…/ }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'README.md', exact: true }).click();
	await page.waitForFunction(() => [...document.querySelectorAll('.commit-diff .diff-line code')].some((el) => el.textContent?.includes('每个工作副本都有自己的提交草稿')));
	await page.getByRole('button', { name: '稍后继续', exact: true }).click();
	// Browse a repository inline and save an exact remote URL as a child bookmark.
	const repo = (await call(page, 'state')).repositories[0];
	await page.getByRole('button', { name: `浏览仓库 ${repo.name}`, exact: true }).click();
	await page.locator('.remote-surface').waitFor();
	assert.equal(await page.getByRole('dialog').count(), 0);
	await page.getByRole('button', { name: /trunk\// }).click();
	await page.getByRole('button', { name: '保存路径', exact: true }).click();
	await page.waitForFunction(async () => (await window.svnbox.call('state', undefined)).bookmarks.length === 1);
	assert.equal((await call(page, 'state')).bookmarks[0].url, `${url}/trunk`);
	await page.screenshot({ path: resolve('test-results/remote-browser.png') });
	await page.getByRole('button', { name: '仓盒应用 trunk · 本地工作副本', exact: false }).first().click();

	// Race UI refreshes, then switch immediately; the UI must retain the final project.
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'refresh'));
	await page.evaluate(
		async ({ firstId, secondId }) => {
			void window.svnbox.call('status', { wcId: firstId });
			void window.svnbox.call('status', { wcId: secondId });
		},
		{ firstId: first.id, secondId: second.id },
	);
	await page.getByRole('button', { name: '设计系统 trunk · 本地工作副本', exact: false }).first().click();
	await page.getByRole('tab', { name: '文件', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.project-heading h1')?.textContent?.includes('设计系统'));
	await page.waitForFunction(() => ![...document.querySelectorAll('.file-name')].some((el) => el.textContent?.includes('app.ts')));
	await page.getByRole('textbox', { name: '搜索文件', exact: true }).fill('README');
	await instance.close();
	desktop = await launch();
	const restored = await call(desktop.page, 'state');
	assert.equal(restored.workingCopies.length, 2);
	assert.equal(restored.bookmarks.length, 1);
	assert.equal(restored.sessions[second.id].draft, '设计系统的独立草稿');
	assert.equal(restored.sessions[first.id].draft, '');
	assert.equal(restored.sessions[second.id].fileSearch, 'README');
	assert.equal(await desktop.page.getByRole('textbox', { name: '搜索文件', exact: true }).inputValue(), 'README');
	await desktop.page.getByRole('button', { name: '仓盒应用 trunk · 本地工作副本', exact: false }).first().click();
	await desktop.page.getByRole('tab', { name: '文件', exact: true }).click();
	await desktop.page.getByRole('button', { name: 'README.md', exact: false }).first().click();
	await desktop.page.waitForFunction(() => [...document.querySelectorAll('.diff-line code')].some((el) => el.textContent?.includes('svnbox')));
	await call(desktop.page, 'settings', { theme: 'dark' });
	await desktop.instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'settings'));
	await desktop.page.getByRole('button', { name: '深色', exact: true }).click();
	await desktop.page.getByLabel('可执行文件路径', { exact: true }).fill('/tmp/svnbox-tool-that-does-not-exist');
	await desktop.page.getByRole('button', { name: '保存并检测', exact: true }).click();
	await desktop.page.locator('[data-sonner-toast][data-type="error"]').waitFor();
	assert.equal(await desktop.page.getByRole('dialog').count(), 1);
	await desktop.page.getByLabel('可执行文件路径', { exact: true }).fill('/opt/homebrew/bin/svn');
	await desktop.page.getByRole('button', { name: '保存并检测', exact: true }).click();
	await desktop.page.locator('[data-sonner-toast]').filter({ hasText: '设置已保存' }).waitFor();
	await desktop.page.getByRole('button', { name: '关闭', exact: true }).first().click();
	await desktop.page.screenshot({ path: resolve('test-results/workspace-dark.png') });
	assert.equal(await desktop.page.locator('select').count(), 0);
	await desktop.page.getByRole('button', { name: '添加项目', exact: true }).click();
	await desktop.page.getByRole('menuitem', { name: '新建分组…', exact: true }).click();
	await desktop.page.getByRole('textbox', { name: '名称', exact: true }).fill('客户端项目');
	await desktop.page.getByRole('button', { name: '保存', exact: true }).click();
	await desktop.page.locator('.repository-children .nav-copy-main').filter({ hasText: '仓盒应用' }).click({ button: 'right' });
	await desktop.page.getByRole('menuitem', { name: '名称与分组…', exact: true }).click();
	await desktop.page.getByRole('combobox', { name: '所属分组', exact: true }).click();
	await desktop.page.getByRole('combobox', { name: '搜索所属分组', exact: true }).fill('客户端');
	await desktop.page.getByRole('option', { name: '客户端项目', exact: true }).click();
	await desktop.page.getByRole('button', { name: '保存', exact: true }).click();
	const grouped = await call(desktop.page, 'state');
	assert.equal(grouped.workingCopies.find((copy) => copy.id === first.id).groupId, grouped.groups[0].id);
	await desktop.instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }));
	await desktop.page.screenshot({ path: resolve('test-results/workspace-compact.png') });
	await desktop.page.locator('.remote-bookmark button[title]').first().click();
	await desktop.page.locator('.remote-entry').first().waitFor();
	await desktop.page.getByRole('button', { name: '检出此目录', exact: true }).scrollIntoViewIfNeeded();
	assert.equal(await desktop.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
	await desktop.page.screenshot({ path: resolve('test-results/remote-compact.png') });

	const security = await desktop.instance.evaluate(({ BrowserWindow }) => {
		const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
		return { sandbox: prefs.sandbox, isolation: prefs.contextIsolation, node: prefs.nodeIntegration };
	});
	assert.deepEqual(security, { sandbox: true, isolation: true, node: false });
	assert.equal(await desktop.page.evaluate(() => typeof window.require), 'undefined');
	assert.equal(errors.length, 0, errors.join('\n'));
	console.log(
		JSON.stringify(
			{
				result: 'passed',
				workingCopies: 2,
				fileMergeVerified,
				checks: [
					'添加副本',
					'中文 @ Diff',
					'选择性提交 UI',
					'提交审阅',
					'更新',
					'历史差异',
					'跨副本草稿隔离',
					'重启恢复',
					'快速切换',
					'浅深色主题',
					'键盘列表与菜单',
					'Electron 安全配置',
					'仓库与路径组织',
					'shadcn Combobox',
					'历史视图下的本地提交差异',
					'非阻断 toast 反馈',
				],
				screenshots: 'test-results/',
			},
			null,
			2,
		),
	);
	if (process.env.SVNBOX_KEEP_E2E) {
		console.log(`保留测试数据：${root}`);
	}
} finally {
	await desktop?.instance.close().catch(() => {});
	if (!process.env.SVNBOX_KEEP_E2E) {
		await rm(root, { recursive: true, force: true });
	}
}
