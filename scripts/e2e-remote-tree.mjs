import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-remote-tree-')));
const repo = join(root, 'repository');
const otherRepo = join(root, 'other-repository');
const seed = join(root, 'seed');
const control = join(root, 'control.json');
const trace = join(root, 'commands.jsonl');
const wrapper = join(root, 'svn-wrapper.cjs');
const svn = (...args) => execFileSync('/opt/homebrew/bin/svn', args, { encoding: 'utf8' });
const url = pathToFileURL(repo).href;
const childUrl = (name) => `${url}/publish/${encodeURIComponent(name)}`;
let instance;
let page;
const errors = [];

async function call(method, input) {
	return page.evaluate(({ method, input }) => window.svnbox.call(method, input), { method, input });
}

async function configure(value) {
	await writeFile(control, JSON.stringify(value));
}

async function waitUntil(check, timeout = 10000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error('Timed out waiting for remote tree behavior');
}

const node = (name) => page.getByRole('treeitem', { name, exact: true });

async function expand(name) {
	await node(name)
		.getByRole('button', { name: `展开 ${name}`, exact: true })
		.click();
}

async function openRepository(name) {
	await page.getByRole('button', { name: `浏览仓库 ${name}`, exact: true }).click();
	await node('publish').waitFor();
}

try {
	for (const path of [repo, otherRepo]) {
		execFileSync('/opt/homebrew/bin/svnadmin', ['create', path]);
	}
	svn('checkout', url, seed);
	for (const path of ['dm_client/ga', 'mgo_client', 'mm_client', 'empty', '中文 空格 @', 'many']) {
		await mkdir(join(seed, 'publish', path), { recursive: true });
	}
	await writeFile(join(seed, 'publish/dm_client/ga/index.html'), '<p>remote tree</p>\n');
	await writeFile(join(seed, 'publish/mgo_client/style.css'), 'body { color: green; }\n');
	await writeFile(join(seed, 'publish/mm_client/config.json'), '{"live":true}\n');
	await writeFile(join(seed, 'publish/中文 空格 @/中文 @ #%.ts'), 'export const result = 1;\n');
	for (let index = 0; index < 600; index++) {
		await writeFile(join(seed, `publish/many/file-${String(index).padStart(3, '0')}.txt`), `${index}\n`);
	}
	svn('add', `${seed}/publish@`);
	svn('commit', `${seed}@`, '-m', 'Remote browser fixture', '--username', 'tree-tester');
	svn('mkdir', `${pathToFileURL(otherRepo).href}/publish`, '-m', 'Isolated second repository');
	await configure({});
	await writeFile(
		wrapper,
		String.raw`#!${process.execPath}
const { spawn } = require('node:child_process');
const { readFileSync, appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const target = args.find(value => value.startsWith('file:'))?.replace(/@$/, '');
const config = JSON.parse(readFileSync(${JSON.stringify(control)}, 'utf8'));
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ command: args[0], target }) + '\n');
process.on('SIGTERM', () => { appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ cancelled: target }) + '\n'); process.exit(143); });
setTimeout(() => {
  if (args[0] === 'list' && config.fail === target) {
    process.stderr.write('svn: E170013: simulated directory connection failure\n');
    process.exit(1);
  }
  const child = spawn(${JSON.stringify(resolve('resources/svn/darwin-arm64/bin/svn'))}, args, { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 1));
}, args[0] === 'list' && config.slow === target ? 4000 : 0);
`,
		{ mode: 0o700 },
	);
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: join(root, 'data') },
	});
	page = await instance.firstWindow();
	page.setDefaultTimeout(10000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForSelector('.welcome');
	await instance.evaluate(({ BrowserWindow, app }) => {
		BrowserWindow.getAllWindows()[0].setContentSize(1680, 1050);
		app.focus({ steal: true });
	});
	await call('settings', { svnPath: wrapper, language: 'zh-CN', theme: 'light' });
	await call('addRepository', { url, name: 'Remote Studio' });
	await call('addRepository', { url: pathToFileURL(otherRepo).href, name: 'Other Studio' });
	await page.reload();
	await openRepository('Remote Studio');
	await expand('publish');
	await node('dm_client').waitFor();

	// A slow child leaves its ancestors and siblings interactive; a second branch loads independently.
	await configure({ slow: childUrl('mgo_client') });
	await expand('mgo_client');
	await waitUntil(async () => (await node('mgo_client').getAttribute('aria-busy')) === 'true');
	await expand('dm_client');
	await node('ga').waitFor({ timeout: 2500 });
	assert.equal(await node('mgo_client').getAttribute('aria-busy'), 'true');
	assert.equal(await node('publish').getAttribute('aria-expanded'), 'true');
	await mkdir(resolve('test-results'), { recursive: true });
	await page.screenshot({ path: resolve('test-results/remote-tree-loading.png') });
	await node('mgo_client').getByRole('button', { name: '停止连接 mgo_client', exact: true }).click();
	await page.locator('.remote-tree-status').filter({ hasText: '连接已停止' }).waitFor();
	await waitUntil(async () => (await readFile(trace, 'utf8')).includes(JSON.stringify({ cancelled: childUrl('mgo_client') })));
	assert.equal(await node('ga').isVisible(), true);
	await configure({});
	await page.locator('.remote-tree-status').filter({ hasText: '连接已停止' }).getByRole('button').click();
	await node('style.css').waitFor();

	// Failure and empty state belong to one directory, without replacing the loaded tree.
	await configure({ fail: childUrl('mm_client') });
	await expand('mm_client');
	await page.locator('.remote-tree-status.error-text').waitFor();
	assert.equal(await node('style.css').isVisible(), true);
	await configure({});
	await page.locator('.remote-tree-status.error-text').getByRole('button').click();
	await node('config.json').waitFor();
	await expand('empty');
	await page.locator('.remote-tree-status').filter({ hasText: '空目录' }).waitFor();
	await expand('ga');
	await node('index.html').waitFor();
	await expand('中文 空格 @');
	await node('中文 @ #%.ts').waitFor();
	assert.match(await node('中文 @ #%.ts').getAttribute('data-url'), /%E4%B8%AD%E6%96%87%20%40%20%23%25.ts$/);

	// A file cannot accidentally check out the previous directory; a selected folder is the exact bookmark/checkout target.
	await page.getByPlaceholder('选择本地文件夹', { exact: true }).fill(root);
	await node('中文 @ #%.ts').click();
	assert.equal(await page.getByRole('button', { name: '检出此目录', exact: true }).isDisabled(), true);
	assert.equal(await page.getByRole('button', { name: '保存路径', exact: true }).isDisabled(), true);
	await page.getByRole('tree').press('ArrowLeft');
	assert.equal(await node('中文 空格 @').getAttribute('aria-selected'), 'true');
	await page.getByRole('button', { name: '保存路径', exact: true }).click();
	await waitUntil(async () => (await call('state')).bookmarks.length === 1);
	assert.equal((await call('state')).bookmarks[0].url, childUrl('中文 空格 @'));
	await page.getByRole('textbox', { name: '新文件夹名称', exact: true }).fill('检出 中文 @');
	await page.screenshot({ path: resolve('test-results/remote-tree-light.png') });
	await page.getByRole('button', { name: '检出此目录', exact: true }).click();
	await waitUntil(async () => (await call('operations')).some((operation) => operation.action === 'checkout' && operation.state === 'success'));
	assert.equal(await readFile(join(root, '检出 中文 @/中文 @ #%.ts'), 'utf8'), 'export const result = 1;\n');
	assert.equal(decodeURIComponent(svn('info', '--show-item', 'url', `${root}/检出 中文 @@`).trim()), decodeURIComponent(childUrl('中文 空格 @')));

	await openRepository('Remote Studio');
	await expand('publish');
	await node('many').waitFor();
	await expand('many');
	await node('file-000.txt').waitFor();
	assert.ok((await page.locator('.remote-entry').count()) < 100, 'Large remote directories must remain virtualized');
	await page.getByRole('tree').press('End');
	await node('file-599.txt').waitFor();
	assert.equal(await node('mm_client').getAttribute('aria-selected'), 'true');
	await node('file-599.txt').click();
	await page.getByRole('tree').press('ArrowLeft');
	await node('many').waitFor();
	await page.getByRole('tree').press('ArrowLeft');
	await waitUntil(async () => (await node('many').getAttribute('aria-expanded')) === 'false');

	// Switching repositories aborts old work and prevents its late response from changing the next tree.
	await configure({ slow: childUrl('mgo_client') });
	await expand('mgo_client');
	await waitUntil(async () => (await node('mgo_client').getAttribute('aria-busy')) === 'true');
	await openRepository('Other Studio');
	await expand('publish');
	await page.locator('.remote-tree-status').filter({ hasText: '空目录' }).waitFor();
	assert.equal(await node('style.css').count(), 0);
	assert.equal(await node('mgo_client').count(), 0);
	assert.equal(await page.locator('.remote-entry').count(), 2);
	await configure({ slow: pathToFileURL(otherRepo).href });
	await page.getByRole('button', { name: '浏览', exact: true }).click();
	await waitUntil(async () => (await page.getByRole('treeitem').first().getAttribute('aria-busy')) === 'true');
	await page.getByRole('button', { name: '停止连接', exact: true }).click();
	await page.locator('.remote-tree-status').filter({ hasText: '连接已停止' }).waitFor();
	await configure({});
	await page.locator('.remote-tree-status').getByRole('button').click();
	await node('publish').waitFor();
	await call('settings', { theme: 'dark' });
	await page.reload();
	await openRepository('Remote Studio');
	await expand('publish');
	await configure({ slow: childUrl('mgo_client') });
	await expand('mgo_client');
	await waitUntil(async () => (await node('mgo_client').getAttribute('aria-busy')) === 'true');
	await node('mgo_client').getByRole('button', { name: '收起 mgo_client', exact: true }).click();
	assert.equal(await node('mgo_client').getAttribute('aria-busy'), 'false');
	await configure({});
	await expand('mgo_client');
	await node('style.css').waitFor();
	await expand('dm_client');
	await node('ga').waitFor();
	await expand('ga');
	await node('index.html').waitFor();
	await page.screenshot({ path: resolve('test-results/remote-tree-dark.png') });
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify({
			passed: true,
			checks: [
				'lazy branches',
				'inline progress and cancel',
				'parallel siblings',
				'retry',
				'empty',
				'special paths',
				'keyboard',
				'exact bookmark/checkout',
				'virtualized 600 files',
				'repository isolation',
			],
			screenshots: 'test-results/remote-tree-*.png',
		}),
	);
} catch (error) {
	await page?.screenshot({ path: resolve('test-results/remote-tree-failure.png') }).catch(() => {});
	console.error(error);
	process.exitCode = 1;
} finally {
	await instance?.close();
	await rm(root, { recursive: true, force: true });
}
