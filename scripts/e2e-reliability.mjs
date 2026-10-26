import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-update-feedback-')));
const repo = join(root, 'repository');
const copies = ['更新甲', '更新乙'].map((name) => join(root, name));
const failure = join(root, 'fail-status');
const trace = join(root, 'commands.jsonl');
const relative = '目录 空格/中文 @ 文件.txt';
const wrapper = join(root, 'slow-svn.cjs');
const svn = (...args) => execFileSync('/opt/homebrew/bin/svn', args, { encoding: 'utf8' });
let instance;
let page;
const errors = [];
const feedbackMs = [];

async function call(method, input) {
	return page.evaluate(({ method, input }) => window.svnbox.call(method, input), { method, input });
}

async function useCopy(name) {
	await page
		.getByRole('button', { name: new RegExp(`${name}.*本地工作副本`) })
		.first()
		.click();
	await page.waitForFunction((name) => document.querySelector('.project-heading h1')?.textContent === name, name);
}

async function waitUntil(check, timeout = 20000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('Timed out waiting for SVN behavior');
}

async function commands() {
	return (await readFile(trace, 'utf8').catch(() => ''))
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

async function scans() {
	return (await commands()).filter((entry) => entry.command === 'status');
}

async function focusBurst() {
	await instance.evaluate(({ app }) => app.focus({ steal: true }));
	await page.bringToFront();
	await page.evaluate(() => {
		for (let i = 0; i < 6; i++) {
			window.dispatchEvent(new Event('focus'));
			document.dispatchEvent(new Event('visibilitychange'));
		}
	});
}

async function updatesFinished(count) {
	await waitUntil(async () => {
		const updates = (await call('operations')).filter((op) => op.action === 'update');
		return updates.length === count && updates.every((op) => op.state === 'success');
	});
}

async function burstUpdate() {
	await instance.evaluate(({ BrowserWindow }) => {
		for (let index = 0; index < 4; index++) {
			BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'update');
		}
	});
	await page.getByRole('button', { name: '更新', exact: true }).evaluate((button) => {
		button.click();
		button.click();
	});
}

try {
	execFileSync('/opt/homebrew/bin/svnadmin', ['create', repo]);
	const url = `${pathToFileURL(repo).href}/trunk`;
	svn('mkdir', url, '-m', '更新反馈临时仓库');
	svn('checkout', url, copies[0]);
	await mkdir(join(copies[0], '目录 空格'));
	await writeFile(join(copies[0], relative), 'original\n');
	await writeFile(join(copies[0], 'README.md'), '# original\n');
	svn('add', `${copies[0]}/目录 空格@`, `${copies[0]}/README.md@`);
	svn('commit', `${copies[0]}@`, '-m', 'seed');
	svn('checkout', url, copies[1]);
	await writeFile(join(copies[0], relative), 'modified\n');
	await writeFile(join(copies[0], 'README.md'), '# keep modification\n');
	await writeFile(join(copies[0], 'untracked.txt'), 'keep me\n');
	await writeFile(
		wrapper,
		String.raw`#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ command: args[0], cwd: process.cwd(), args }) + '\n');
const delay = args[0] === 'status' ? 650 : args[0] === 'update' ? 800 : 0;
setTimeout(() => {
  if (args[0] === 'status' && existsSync(${JSON.stringify(failure)})) {
    process.stderr.write('svn: E155007: simulated path is not a working copy\n');
    process.exit(1);
  }
  const child = spawn(${JSON.stringify(resolve('resources/svn/darwin-arm64/bin/svn'))}, args, { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 1));
}, delay);
`,
		{ mode: 0o700 },
	);
	assert.match(execFileSync(wrapper, ['--version', '--quiet'], { encoding: 'utf8' }), /^1\./);
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: join(root, 'data') },
	});
	page = await instance.firstWindow();
	page.setDefaultTimeout(10000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForSelector('.welcome');
	await instance.evaluate(({ app }) => app.focus({ steal: true }));
	for (const copy of copies) {
		await call('addWorkingCopy', { path: copy });
	}
	await page.reload();
	await useCopy('更新甲');
	await page.waitForFunction(() => document.querySelector('.scan-time')?.textContent?.startsWith('本地扫描 '));

	// A normal directory must expose a recursive discard action without widening its scope.
	await page.locator('.file-row[data-path="目录 空格"]').click({ button: 'right' });
	await page.getByRole('menuitem', { name: '撤销本地修改…', exact: true }).click();
	await page.getByRole('dialog').getByRole('checkbox').waitFor();
	const scope = await page.locator('.review-path code').allTextContents();
	assert.ok(scope.includes(relative));
	assert.ok(scope.includes('目录 空格'));
	assert.ok(!scope.includes('README.md'));
	assert.equal(await page.getByRole('button', { name: '撤销所选本地修改', exact: true }).isDisabled(), true);
	await page.getByRole('dialog').getByRole('checkbox').check();
	await page.getByRole('button', { name: '撤销所选本地修改', exact: true }).click();
	await waitUntil(async () => (await call('operations')).some((op) => op.action === 'revert' && op.state === 'success'));
	assert.equal(await readFile(join(copies[0], relative), 'utf8'), 'original\n');
	assert.equal(await readFile(join(copies[0], 'README.md'), 'utf8'), '# keep modification\n');
	assert.equal(await readFile(join(copies[0], 'untracked.txt'), 'utf8'), 'keep me\n');
	await page.locator('.file-row[data-path="."]').click({ button: 'right' });
	await page.getByRole('menuitem', { name: '撤销整个副本的本地修改…', exact: true }).waitFor();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: /^提交…/ }).click();
	await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('保留的提交草稿');
	await page.getByRole('checkbox', { name: '提交 README.md', exact: true }).check();
	await page.getByRole('button', { name: '稍后继续', exact: true }).click();
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'settings'));
	const settings = page.getByRole('dialog', { name: '设置', exact: true });
	await settings.getByRole('tab', { name: '工具', exact: true }).click();
	await settings.getByLabel('可执行文件路径', { exact: true }).fill(wrapper);
	await settings.getByRole('button', { name: '保存并检测', exact: true }).click();
	await page.locator('[data-sonner-toast]').filter({ hasText: '设置已保存' }).waitFor();
	await settings.getByRole('button', { name: '关闭', exact: true }).first().click();

	// Focus scans only the current copy, with no remote status check or write command.
	await page.waitForFunction(() => document.querySelector('.scan-time')?.textContent.startsWith('本地扫描 '));
	const before = (await scans()).length;
	await writeFile(join(copies[0], relative), 'external change\n');
	await focusBurst();
	await waitUntil(async () => (await scans()).length > before);
	await page.waitForFunction(() => document.querySelector('.scan-time')?.textContent.startsWith('本地扫描 '));
	await page.waitForTimeout(1800);
	const automatic = (await scans()).slice(before);
	assert.equal(automatic.length, 1, 'Focus/visibility bursts produce one local scan');
	assert.equal(automatic[0].cwd, copies[0]);
	assert.equal(automatic[0].args.includes('--show-updates'), false);
	assert.equal((await call('state')).sessions[(await call('state')).activeId].draft, '保留的提交草稿');
	assert.equal((await commands()).filter((entry) => entry.command === 'update').length, 0);
	// A focus during a slow scan must reuse its result rather than cancel or duplicate it.
	const simultaneous = (await scans()).length;
	await focusBurst();
	await waitUntil(async () => (await scans()).length > simultaneous);
	await focusBurst();
	await page.waitForFunction(() => document.querySelector('.scan-time')?.textContent.startsWith('本地扫描 '));
	await page.waitForTimeout(1700);
	assert.equal((await scans()).length, simultaneous + 1);
	const update = page.getByRole('button', { name: '更新', exact: true });
	const start = Date.now();
	await update.click();
	const preparation = page.locator('[data-sonner-toast]').filter({ hasText: '准备更新工作副本' });
	await preparation.waitFor({ timeout: 400 });
	feedbackMs.push(Date.now() - start);
	assert.equal(await update.isDisabled(), true, '准备阶段必须立即禁用更新按钮');
	const firstToast = await preparation.elementHandle();
	await burstUpdate();
	await focusBurst();
	await useCopy('更新乙');
	assert.equal(await update.isEnabled(), true, '另一副本在准备期间仍应可以操作');
	await useCopy('更新甲');
	assert.equal(await update.isDisabled(), true, '切回副本后不能绕过准备锁');
	await burstUpdate();
	await page.getByText('更新工作副本…', { exact: true }).waitFor();
	await burstUpdate();
	await updatesFinished(1);
	await page.getByText('更新工作副本完成', { exact: true }).waitFor();
	assert.equal(await firstToast.evaluate((node) => node.isConnected && node.textContent.includes('更新工作副本完成')), true, '准备、执行和结果必须更新同一条 toast');
	await page.waitForFunction(() => document.querySelector('.scan-time')?.textContent?.startsWith('本地扫描 '));
	assert.equal(await update.isEnabled(), true);
	assert.equal((await call('operations')).filter((op) => op.action === 'update').length, 1, '连续点击和快捷键只能创建一个更新任务');

	await writeFile(failure, '1');
	await update.click();
	await preparation.waitFor({ timeout: 400 });
	const failedToast = await preparation.elementHandle();
	await page.waitForFunction((node) => node.getAttribute('data-type') === 'error', failedToast);
	assert.equal(await update.isEnabled(), true, '准备失败后必须解除禁用');
	assert.equal((await call('operations')).filter((op) => op.action === 'update').length, 1, '准备失败不能创建更新任务');
	await rm(failure);
	await update.click();
	await preparation.waitFor({ timeout: 400 });
	await burstUpdate();
	await updatesFinished(2);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify(
			{
				result: 'passed',
				feedbackMs,
				checks: [
					'目录和根目录撤销入口、实际范围与确认',
					'焦点扫描合并且只读当前副本',
					'忙碌期间去重与跨副本隔离',
					'草稿和未受控内容保留',
					'慢扫描前即时 toast 和禁用',
					'点击/快捷键防重',
					'切换副本隔离',
					'同一 toast 衔接终态',
					'准备失败解锁和重新执行',
				],
			},
			null,
			2,
		),
	);
} finally {
	if (page && !page.isClosed()) {
		const active = await call('operations').catch(() => []);
		for (const op of active.filter((op) => ['waiting', 'running'].includes(op.state))) {
			await call('cancel', { id: op.id }).catch(() => {});
		}
		await waitUntil(async () => (await call('operations')).every((op) => !['waiting', 'running'].includes(op.state)), 5000).catch(() => {});
	}
	await instance?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
