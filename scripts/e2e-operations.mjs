import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-logs-')));
const repository = join(root, 'repository');
const copies = ['客户端 @ 主干', '资源与设计系统'].map((name) => join(root, name));
const data = join(root, 'data');
const slow = join(root, 'slow-update');
const wrapper = join(root, 'svn-wrapper.cjs');
const svn = (...args) => execFileSync('/opt/homebrew/bin/svn', args, { encoding: 'utf8' });
const results = resolve('test-results');
let instance;
let page;
const errors = [];
const checks = [];

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
	await instance.evaluate(({ app }) => app.focus({ steal: true }));
}

async function openLogs() {
	if (!(await page.locator('.operations-dialog').count())) {
		await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'operations'));
	}
	await page.getByRole('dialog', { name: '操作日志', exact: true }).waitFor();
}

async function execute(wcId, action = 'update', paths = []) {
	const review = await call('review', { wcId, action, paths });
	return call('execute', { reviewId: review.id });
}

async function finish(id, expected = 'success') {
	const deadline = Date.now() + 60000;
	while (Date.now() < deadline) {
		const operation = (await call('operations')).find((entry) => entry.id === id);
		if (operation && !['running', 'waiting'].includes(operation.state)) {
			assert.equal(operation.state, expected, JSON.stringify(operation));
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Operation did not finish: ${JSON.stringify(await call('operations'))}`);
}

async function clearVisible() {
	await page.getByRole('button', { name: '清空日志', exact: true }).click();
	await page.getByRole('button', { name: '确认清空', exact: true }).click();
	await page.locator('.logs-clear-confirm').waitFor({ state: 'hidden' });
}

try {
	await mkdir(results, { recursive: true });
	execFileSync('/opt/homebrew/bin/svnadmin', ['create', repository]);
	const url = `${pathToFileURL(repository).href}/trunk`;
	svn('mkdir', url, '-m', '日志界面临时测试仓库');
	for (const copy of copies) {
		svn('checkout', url, copy);
	}
	await mkdir(join(copies[0], '资源目录'));
	for (let batch = 0; batch < 40; batch++) {
		await Promise.all(
			Array.from({ length: 100 }, (_, index) =>
				writeFile(join(copies[0], '资源目录', `中文 @ 文件 ${String(batch * 100 + index).padStart(4, '0')}.txt`), '日志大列表测试\n'),
			),
		);
	}
	svn('add', `${copies[0]}/资源目录@`);
	svn('commit', `${copies[0]}@`, '-m', '提交4000个文件用于真实更新输出');
	await writeFile(
		wrapper,
		String.raw`#!${process.execPath}
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const args = process.argv.slice(2);
setTimeout(() => {
 const child = spawn(${JSON.stringify(resolve('resources/svn/darwin-arm64/bin/svn'))}, args, { stdio: 'inherit' });
 child.on('exit', code => process.exit(code ?? 1));
}, args[0] === 'update' && existsSync(${JSON.stringify(slow)}) ? 15000 : 0);
`,
		{ mode: 0o700 },
	);
	await launch();
	await openLogs();
	await page.getByText('暂无操作日志', { exact: true }).waitFor();
	assert.equal(await page.getByRole('button', { name: '清空日志', exact: true }).isDisabled(), true);
	await page.getByRole('button', { name: '关闭', exact: true }).click();
	for (const copy of copies) {
		await call('addWorkingCopy', { path: copy });
	}
	await page.reload();
	const state = await call('state');
	const [a, b] = copies.map((path) => state.workingCopies.find((copy) => copy.path === path));
	await call('settings', { svnPath: wrapper });
	const large = await execute(b.id);
	await finish(large.id);
	console.log('Real large update completed');
	for (let index = 0; index < 4; index++) {
		const operation = await execute(a.id);
		await finish(operation.id);
	}
	const changed = '资源目录/中文 @ 文件 0000.txt';
	await writeFile(join(copies[0], changed), '审阅时\n');
	const review = await call('review', { wcId: a.id, action: 'commit', paths: [changed], message: '不会提交的过期审阅' });
	await writeFile(join(copies[0], changed), '审阅后又修改\n');
	const failed = await call('execute', { reviewId: review.id });
	await finish(failed.id, 'failed');
	await openLogs();
	assert.equal(await page.locator('[data-operation-id]').count(), 6);
	await page.locator(`[data-operation-id="${failed.id}"]`).click();
	await page.locator('.logs-note.failed').waitFor();
	await page.screenshot({ animations: 'disabled', path: join(results, 'operations-failed-light.png') });
	checks.push('真实更新与失败状态，紧凑列表/独立输出');
	await page.locator(`[data-operation-id="${large.id}"]`).click();

	await page.waitForFunction((id) => document.querySelector('[data-operation-id][aria-selected="true"]')?.getAttribute('data-operation-id') === id, large.id);
	await page.waitForFunction(() => Number(document.querySelector('.logs-line-count')?.textContent?.replace(/\D/g, '')) > 4000);
	assert.ok((await page.locator('.logs-output-line').count()) < 100, '4000行输出只渲染可见行');
	const alignment = await page.evaluate(() => {
		const center = (element) => {
			const rect = element.getBoundingClientRect();
			return rect.y + rect.height / 2;
		};
		const search = document.querySelector('.logs-search');
		const follow = document.querySelector('.logs-output-toolbar label');
		return {
			search: Math.abs(center(search.querySelector('svg')) - center(search.querySelector('input'))),
			follow: Math.abs(center(follow) - center(follow.querySelector('input'))),
		};
	});
	assert.ok(alignment.search < 1 && alignment.follow < 1, `横排控件垂直居中: ${JSON.stringify(alignment)}`);
	await page.getByRole('button', { name: '复制', exact: true }).click();
	await page.locator('[data-sonner-toast]').filter({ hasText: '已复制日志' }).waitFor();
	const copied = await instance.evaluate(({ clipboard }) => clipboard.readText());
	assert.ok(copied.includes('中文 @ 文件 3999.txt') && copied.split('\n').length > 4000, `复制日志: ${copied.length}字符 ${copied.split('\n').length}行`);
	await page.locator('.logs-output-viewport').evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.waitForFunction(() => !document.querySelector('.logs-output-toolbar input').checked);
	await page.getByRole('button', { name: '跳到日志末尾' }).click();
	await page.waitForFunction(() => document.querySelector('.logs-output-toolbar input').checked);
	await page.screenshot({ animations: 'disabled', path: join(results, 'operations-light.png') });
	await page.locator('.operations-dialog').screenshot({ animations: 'disabled', path: join(results, 'operations-dialog-light.png') });
	await page.evaluate(() => document.documentElement.classList.add('dark'));
	await page.screenshot({ animations: 'disabled', path: join(results, 'operations-dark.png') });
	await page.locator('.operations-dialog').screenshot({ animations: 'disabled', path: join(results, 'operations-dialog-dark.png') });
	checks.push('4000行真实命令输出虚拟化、完整复制、滚动/自动跟随');
	await page.keyboard.press('Meta+f');
	assert.equal(await page.getByRole('textbox', { name: '搜索日志', exact: true }).evaluate((element) => element === document.activeElement), true);
	await page.getByRole('textbox', { name: '搜索日志', exact: true }).fill('中文 @ 文件 3999.txt');
	await page.waitForFunction(() => document.querySelectorAll('[data-operation-id]').length === 1);
	await page.getByRole('button', { name: '清除搜索', exact: true }).click();
	await page.getByRole('combobox', { name: '日志状态', exact: true }).click();
	await page.getByRole('option', { name: '失败', exact: true }).click();
	assert.equal(await page.locator('[data-operation-id]').count(), 1);
	await page.getByRole('button', { name: '清空日志', exact: true }).click();
	await page.getByRole('button', { name: '取消', exact: true }).click();
	assert.equal((await call('operations')).length, 6);
	await clearVisible();
	assert.equal((await call('operations')).length, 5);
	await page.getByRole('button', { name: '重置筛选', exact: true }).click();
	await page.getByRole('combobox', { name: '日志项目', exact: true }).click();
	await page.getByRole('option', { name: b.name, exact: false }).click();
	assert.equal(await page.locator('[data-operation-id]').count(), 1);
	await clearVisible();
	assert.equal((await call('operations')).length, 4);
	await page.getByRole('button', { name: '重置筛选', exact: true }).click();
	checks.push('搜索输出、CmdF、状态与项目筛选、确认取消、按筛选范围清空');
	await page.getByRole('grid', { name: '操作日志列表' }).focus();
	await page.keyboard.press('End');
	assert.equal(await page.locator('[data-operation-id][aria-selected="true"]').getAttribute('data-operation-id'), (await call('operations')).at(-1).id);
	await page.keyboard.press('Shift+F10');
	await page.getByRole('menuitem', { name: '复制日志', exact: false }).click();
	await writeFile(slow, '1');
	const running = await execute(a.id);
	await page.waitForFunction(async (id) => (await window.svnbox.call('operations')).find((operation) => operation.id === id)?.state === 'running', running.id);
	await clearVisible();
	const remaining = await call('operations');
	assert.deepEqual(
		remaining.map((operation) => operation.id),
		[running.id],
	);
	await page.locator(`[data-operation-id="${running.id}"]`).click();
	assert.equal(await page.getByRole('button', { name: '清空日志', exact: true }).isDisabled(), true);
	await page.getByRole('button', { name: '停止', exact: true }).click();
	await finish(running.id, 'cancelled');
	await page.getByText('操作已取消，已完成的修改不会回滚。', { exact: true }).waitFor();
	await clearVisible();
	await page.getByText('暂无操作日志', { exact: true }).waitFor();
	await page.screenshot({ animations: 'disabled', path: join(results, 'operations-empty.png') });
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680));
	assert.ok(await page.locator('.operations-dialog').evaluate((element) => element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth));
	checks.push('键盘导航与右键复制、运行任务清空保护、真实取消、空状态/小窗口');
	await instance.close();
	instance = undefined;
	assert.deepEqual(JSON.parse(await readFile(join(data, 'operations.json'), 'utf8')), []);
	await launch();
	await openLogs();
	await page.getByText('暂无操作日志', { exact: true }).waitFor();
	assert.deepEqual(await call('operations'), []);
	checks.push('清空持久化，重启不恢复旧日志');
	assert.deepEqual(errors, []);
	const report = { result: 'passed', checks, outputFiles: 4000, rendererErrors: errors };
	await writeFile(join(results, 'operations-verification.json'), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} catch (error) {
	console.error('Log UI checks failed:', error);
	if (page && !page.isClosed()) {
		await page.screenshot({ animations: 'disabled', path: join(results, 'operations-test-failure.png') }).catch(() => {});
	}
	throw error;
} finally {
	if (page && !page.isClosed()) {
		for (const operation of await call('operations').catch(() => [])) {
			if (['running', 'waiting'].includes(operation.state)) {
				await call('cancel', { id: operation.id }).catch(() => {});
			}
		}
		await page
			.waitForFunction(async () => (await window.svnbox.call('operations')).every((operation) => !['running', 'waiting'].includes(operation.state)), undefined, {
				timeout: 5000,
			})
			.catch(() => {});
	}
	await instance?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
