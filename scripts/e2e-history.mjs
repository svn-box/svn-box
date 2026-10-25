import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-history-ui-')));
const repository = join(root, 'repository');
const seed = join(root, 'seed');
const a = join(root, '时间线项目');
const b = join(root, '另一个项目');
const data = join(root, 'data');
const svn = (...args) => execFileSync('/opt/homebrew/bin/svn', args, { encoding: 'utf8' });
const checks = [];
const errors = [];
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
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForSelector('.welcome, .project-header');
	await instance.evaluate(({ app }) => app.focus({ steal: true }));
	await page.bringToFront();
}

async function useCopy(name) {
	await page
		.getByRole('button', { name: new RegExp(`${name}.*本地工作副本`) })
		.first()
		.click();
	await page.waitForFunction((name) => document.querySelector('.project-heading h1')?.textContent?.includes(name), name);
}

async function filter(value) {
	await page.getByRole('textbox', { name: '筛选已加载历史', exact: true }).fill(value);
}

async function expectDiff(text) {
	await page.waitForFunction((text) => [...document.querySelectorAll('.history-inline-diff .diff-line code')].some((node) => node.textContent?.includes(text)), text);
}

try {
	execFileSync('/opt/homebrew/bin/svnadmin', ['create', repository]);
	const url = pathToFileURL(repository).href;
	svn('mkdir', `${url}/trunk`, `${url}/other`, '-m', '建立两个项目');
	svn('checkout', url, seed);
	await writeFile(join(seed, 'trunk/README.md'), '初始内容\n');
	await writeFile(join(seed, 'trunk/中文 @ 文件.ts'), 'export const value = 1;\n');
	await writeFile(join(seed, 'trunk/删除.json'), '{"before":true}\n');
	await writeFile(join(seed, 'other/README.md'), '另一个项目的独立内容\n');
	svn('add', '--force', `${seed}@`);
	svn('propset', 'svn:mime-type', 'text/plain', `${seed}/trunk/README.md@`, `${seed}/other/README.md@`);
	svn('commit', `${seed}@`, '-m', '建立基础文件');
	for (let index = 0; index < 51; index++) {
		await writeFile(join(seed, 'trunk/README.md'), `历史记录 ${index}\n`);
		execFileSync('/opt/homebrew/bin/svnmucc', ['-m', `日常提交 ${index}`, 'put', join(seed, 'trunk/README.md'), `${url}/trunk/README.md`]);
	}
	svn('update', `${seed}@`);
	await mkdir(join(seed, 'trunk/assets'));
	for (let index = 0; index < 600; index++) {
		await writeFile(join(seed, `trunk/assets/资源 ${index}.json`), '{"asset":true}\n');
	}
	await writeFile(join(seed, 'other/README.md'), '同一提交包含副本外路径\n');
	svn('add', `${seed}/trunk/assets@`);
	svn('commit', `${seed}@`, '-m', '资源批量导入与跨目录修改');
	svn('move', `${seed}/trunk/删除.json@`, `${seed}/trunk/新名字.json`);
	svn('commit', `${seed}/trunk@`, '-m', '重命名：保留历史');
	await writeFile(join(seed, 'trunk/中文 @ 文件.ts'), 'export const value = 2;\n// 时间线中的中文差异\n');
	svn('propset', 'svn:keywords', 'Id', `${seed}/trunk/中文 @ 文件.ts@`);
	svn('commit', `${seed}/trunk@`, '-m', '文本与属性同时修改\n完整的第二行提交说明');
	const latest = Number(execFileSync('/opt/homebrew/bin/svnlook', ['youngest', repository], { encoding: 'utf8' }).trim());
	for (let revision = 1; revision <= latest; revision++) {
		const day = revision >= latest - 1 ? 24 : revision === latest - 2 ? 23 : 22;
		const dateFile = join(root, 'date.txt');
		await writeFile(dateFile, `2026-10-${day}T0${revision % 8}:30:00.000000Z`);
		execFileSync('/opt/homebrew/bin/svnadmin', ['setrevprop', repository, '-r', String(revision), 'svn:date', dateFile]);
	}
	svn('checkout', `${url}/trunk`, a);
	svn('checkout', `${url}/other`, b);
	await launch();
	await call('addWorkingCopy', { path: a });
	await call('addWorkingCopy', { path: b });
	await page.reload();
	await useCopy('时间线项目');
	await page.getByRole('tab', { name: '历史', exact: true }).click();
	await page.waitForSelector('.history-day');
	assert.match(await page.locator('.list-footer').innerText(), /已加载 50 条/);
	assert.match(await page.locator('.history-overview').innerText(), /3 天/);
	assert.equal(await page.locator('.history-inline-diff').count(), 0);
	checks.push('真实分页历史按本地日期分组，初始不请求差异');

	// Select the top commit without hiding its paths, then open the comparison inside it.
	await page.locator('.history-commit').first().locator('.history-commit-toggle').click();
	await page.waitForFunction(() => document.querySelector('.commit-message')?.textContent?.includes('完整的第二行提交说明'));
	assert.equal(await page.locator('.history-commit').first().locator('.history-commit-toggle').getAttribute('aria-expanded'), 'false');
	await page.getByRole('button', { name: `查看 r${latest} 本次差异`, exact: true }).click();
	await expectDiff('时间线中的中文差异');
	assert.equal(await page.locator('.history-inline-diff').getAttribute('data-revision'), String(latest));
	assert.match(await page.locator('.history-diff-context').innerText(), new RegExp(`r${latest - 1} → r${latest}`));
	await page.getByRole('button', { name: '并排', exact: true }).click();
	await page.waitForSelector('.history-inline-diff .diff-line.split');
	await page.getByRole('button', { name: '统一', exact: true }).click();
	await expectDiff('svn:keywords');
	checks.push('提交内展开 Diff，版本范围正确，文本与属性差异，统一/并排');

	await page.getByRole('button', { name: '收起差异预览', exact: true }).click();
	await page.getByRole('button', { name: '修改 /trunk/中文 @ 文件.ts', exact: true }).click();
	await expectDiff('时间线中的中文差异');
	assert.match(await page.locator('.history-diff-context').innerText(), /中文 @ 文件.ts/);
	assert.equal(await page.getByRole('button', { name: 'FileMerge', exact: true }).count(), 1);
	const first = (await call('state')).workingCopies.find((copy) => copy.path === a);
	assert.equal((await call('state')).sessions[first.id].historyTarget, '.');
	checks.push('中文空格 @ 路径差异位于本次提交内，FileMerge 入口及查询路径隔离');

	await page.getByRole('button', { name: '收起差异预览', exact: true }).click();
	await filter('重命名：保留历史');
	assert.match(await page.getByRole('button', { name: '新增 /trunk/新名字.json', exact: true }).getAttribute('title'), /复制自/);
	await page.getByRole('button', { name: '删除 /trunk/删除.json', exact: true }).click();
	await expectDiff('"before":true');
	checks.push('已删除路径仍能查看历史删除差异');
	await page.getByRole('button', { name: '收起差异预览', exact: true }).click();
	await filter('资源批量导入');
	assert.ok((await page.locator('.timeline-row').count()) < 100);
	await page.getByRole('button', { name: '修改 /other/README.md', exact: true }).waitFor();
	assert.equal(await page.getByRole('button', { name: '修改 /other/README.md', exact: true }).getAttribute('aria-disabled'), 'true');
	await page.getByRole('button', { name: '修改 /other/README.md', exact: true }).click({ force: true });
	assert.equal(await page.locator('.history-inline-diff').count(), 0);
	await page.locator('.history-timeline').evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await page.waitForFunction(() => [...document.querySelectorAll('.history-changed-path')].some((node) => node.textContent?.includes('资源 99.json')));
	await page.locator('.history-changed-path').last().click();
	await expectDiff('asset');
	assert.ok(
		await page.locator('.history-inline-diff').evaluate((element) => element.getBoundingClientRect().top >= element.closest('.history-timeline').getBoundingClientRect().top),
	);
	await page.getByRole('button', { name: '收起差异预览', exact: true }).click();
	await page.locator('.history-timeline').evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.locator('.history-commit-toggle').waitFor();
	await page.locator('.history-commit-toggle').click();
	assert.equal(await page.locator('.history-changed-path').count(), 0);
	checks.push('600 路径真实提交虚拟化，副本外路径明确禁用，提交可折叠');

	await filter('');
	await page.getByRole('button', { name: '展开全部', exact: true }).click();
	await page.getByRole('button', { name: '收起全部', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.history-day[aria-expanded="false"]').length === 3);
	await page.screenshot({ path: resolve('test-results/history-collapsed.png') });
	await page.getByRole('button', { name: '从服务器加载更早记录', exact: true }).click();
	await page.waitForFunction(() => document.querySelector('.list-footer')?.textContent?.includes('已到历史起点'));
	assert.match(await page.locator('.list-footer').innerText(), new RegExp(`已加载 ${latest} 条`));
	assert.equal(await page.locator('.history-day').count(), 3);
	checks.push('加载更早记录合并同一日期，无重复分组，明确到达起点');

	await page.locator('.history-timeline').focus();
	await page.keyboard.press('Home');
	await page.keyboard.press('ArrowRight');
	await page.waitForSelector('.history-commit');
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowLeft');
	await page.waitForFunction(() => document.querySelector('.history-commit-toggle')?.getAttribute('aria-expanded') === 'false');
	await page.keyboard.press('ArrowRight');
	await page.waitForFunction(() => document.querySelector('.history-commit-toggle')?.getAttribute('aria-expanded') === 'true');
	await page.getByRole('button', { name: `查看 r${latest} 本次差异`, exact: true }).click();
	await expectDiff('时间线中的中文差异');
	await page.screenshot({ path: resolve('test-results/history-timeline-light.png') });
	checks.push('方向键和 Home/End 导航，左右展开折叠，焦点可见');

	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'settings'));
	await page.getByRole('button', { name: '深色', exact: true }).click();
	await page.locator('.dialog-footer').getByRole('button', { name: '关闭', exact: true }).click();
	await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
	await page.screenshot({ path: resolve('test-results/history-timeline-dark.png') });
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }));
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	assert.equal(
		await page.locator('.history-inline-diff').evaluate((element) => element.getBoundingClientRect().right <= element.closest('.work-content').getBoundingClientRect().right),
		true,
	);
	await page.screenshot({ path: resolve('test-results/history-timeline-compact.png') });
	checks.push('浅深色、小窗口下内嵌 Diff 无横向溢出');

	// Delay a real SVN subprocess so cancellation and cross-project races are observable.
	const wrapper = join(root, 'slow-svn.cjs');
	await writeFile(
		wrapper,
		`#!${process.execPath}
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
setTimeout(() => { const child = spawn(${JSON.stringify(resolve('resources/svn/darwin-arm64/bin/svn'))}, args, { stdio: 'inherit' }); child.on('exit', (code) => process.exit(code ?? 1)); }, args.includes('diff') ? 1800 : 0);
`,
		{ mode: 0o700 },
	);
	await page.getByRole('button', { name: '收起差异预览', exact: true }).click();
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'settings'));
	const settings = page.getByRole('dialog', { name: '设置', exact: true });
	await settings.getByLabel('可执行文件路径').fill(wrapper);
	await settings.getByRole('button', { name: '保存并检测', exact: true }).click();
	await settings.getByRole('button', { name: '关闭', exact: true }).first().click();
	await page.waitForSelector('.history-commit');
	await page.getByRole('button', { name: `查看 r${latest} 本次差异`, exact: true }).click();
	await page.getByRole('button', { name: '停止读取', exact: true }).click();
	await page.getByText('已停止读取差异', { exact: true }).waitFor();
	await page.getByRole('button', { name: '重新读取', exact: true }).click();
	await expectDiff('时间线中的中文差异');
	checks.push('真实延迟 SVN 查询可停止，停止后重新读取成功');

	// Start a different preview and switch projects immediately.
	await page.getByRole('button', { name: '收起差异预览', exact: true }).click();
	await filter('资源批量导入');
	if ((await page.locator('.history-day').getAttribute('aria-expanded')) === 'false') {
		await page.locator('.history-day').click();
	}
	await page.getByRole('button', { name: `查看 r${latest - 2} 本次差异`, exact: true }).click();
	await useCopy('另一个项目');
	await page.getByRole('tab', { name: '历史', exact: true }).click();
	await page.waitForSelector('.history-commit');
	assert.equal(await page.getByRole('textbox', { name: '筛选已加载历史', exact: true }).inputValue(), '');
	assert.equal(await page.locator('.history-inline-diff').count(), 0);
	await page
		.locator('.history-commit')
		.first()
		.getByRole('button', { name: /本次差异/ })
		.click();
	await page.waitForSelector('.history-inline-diff', { timeout: 3000 });
	await expectDiff('同一提交包含副本外路径');
	assert.equal(await page.locator('.history-inline-diff code').filter({ hasText: '时间线中的中文差异' }).count(), 0);
	await useCopy('时间线项目');
	assert.equal(await page.getByRole('textbox', { name: '筛选已加载历史', exact: true }).inputValue(), '资源批量导入');
	checks.push('快速切换取消旧差异，筛选/折叠/选择与预览按副本隔离');
	await call('settings', { svnPath: '' });
	await instance.close();
	await launch();
	await page.waitForSelector('.history-commit');
	assert.equal(await page.getByRole('textbox', { name: '筛选已加载历史', exact: true }).inputValue(), '资源批量导入');
	const restored = (await call('state')).sessions[first.id];
	assert.equal(restored.historyPreviewOpen, true);
	assert.equal(restored.historyRevision, latest - 2);
	assert.ok(restored.historyCollapsedDates.length > 0);
	checks.push('重启恢复历史筛选、折叠、提交版本及预览上下文');
	assert.equal(errors.length, 0, errors.join('\n'));
	console.log(JSON.stringify({ result: 'passed', revisions: latest, bulkPaths: 600, checks }, null, 2));
} catch (error) {
	console.error({ completedChecks: checks, error });

	await page?.screenshot({ path: resolve('test-results/history-timeline-failure.png') }).catch(() => {});
	throw error;
} finally {
	await instance?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
