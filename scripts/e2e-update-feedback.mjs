import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-update-feedback-')));
const repo = join(root, 'repository');
const copies = ['更新甲', '更新乙'].map((name) => join(root, name));
const failure = join(root, 'fail-status');
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

async function updatesFinished(count) {
	await page.waitForFunction(
		async (count) => {
			const updates = (await window.svnbox.call('operations')).filter((op) => op.label === '更新工作副本');
			return updates.length === count && updates.every((op) => op.state === 'success');
		},
		count,
		{ timeout: 20000 },
	);
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
	for (const copy of copies) {
		svn('checkout', url, copy);
	}
	await writeFile(
		wrapper,
		String.raw`#!${process.execPath}
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const args = process.argv.slice(2);
const delay = args[0] === 'status' ? 1600 : args[0] === 'update' ? 800 : 0;
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
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'settings'));
	const settings = page.getByRole('dialog', { name: '设置', exact: true });
	await settings.getByRole('tab', { name: '工具', exact: true }).click();
	await settings.getByLabel('可执行文件路径', { exact: true }).fill(wrapper);
	await settings.getByRole('button', { name: '保存并检测', exact: true }).click();
	await page.locator('[data-sonner-toast]').filter({ hasText: '设置已保存' }).waitFor();
	await settings.getByRole('button', { name: '关闭', exact: true }).first().click();

	const update = page.getByRole('button', { name: '更新', exact: true });
	const start = Date.now();
	await update.click();
	const preparation = page.locator('[data-sonner-toast]').filter({ hasText: '准备更新工作副本' });
	await preparation.waitFor({ timeout: 400 });
	feedbackMs.push(Date.now() - start);
	assert.equal(await update.isDisabled(), true, '准备阶段必须立即禁用更新按钮');
	const firstToast = await preparation.elementHandle();
	await burstUpdate();
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
	assert.equal((await call('operations')).filter((op) => op.label === '更新工作副本').length, 1, '连续点击和快捷键只能创建一个更新任务');

	await writeFile(failure, '1');
	await update.click();
	await preparation.waitFor({ timeout: 400 });
	const failedToast = await preparation.elementHandle();
	await page.waitForFunction((node) => node.getAttribute('data-type') === 'error', failedToast);
	assert.equal(await update.isEnabled(), true, '准备失败后必须解除禁用');
	assert.equal((await call('operations')).filter((op) => op.label === '更新工作副本').length, 1, '准备失败不能创建更新任务');
	await rm(failure);
	await update.click();
	await preparation.waitFor({ timeout: 400 });
	await burstUpdate();
	await updatesFinished(2);
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify(
			{ result: 'passed', feedbackMs, checks: ['慢扫描前即时 toast 和禁用', '点击/快捷键防重', '切换副本隔离', '同一 toast 衔接终态', '准备失败解锁和重新执行'] },
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
		await page
			.waitForFunction(async () => (await window.svnbox.call('operations')).every((op) => !['waiting', 'running'].includes(op.state)), undefined, { timeout: 5000 })
			.catch(() => {});
	}
	await instance?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
