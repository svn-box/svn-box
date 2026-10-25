import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-file-ui-')));
const repository = join(root, 'repository');
const copy = join(root, '文件视图');
const svn = (...args) => execFileSync('/opt/homebrew/bin/svn', args, { encoding: 'utf8' });
let instance;
let page;
const errors = [];

try {
	execFileSync('/opt/homebrew/bin/svnadmin', ['create', repository]);
	svn('mkdir', `${pathToFileURL(repository).href}/trunk`, '-m', '初始化文件视图测试');
	svn('checkout', `${pathToFileURL(repository).href}/trunk`, copy);
	const samples = {
		'.env.local': 'NODE_ENV=development\n',
		'app.ts': 'export const app = 1;\n',
		'bundle.zip': 'archive fixture\n',
		'config.json': '{"name":"svnbox"}\n',
		'document.xml': '<document/>\n',
		'image.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
		'notes.txt': '文字内容\n',
		'README.md': '# 仓盒\n',
		'script.js': 'export const value = 1;\n',
		'styles.css': ':root { color: black; }\n',
	};
	for (const [name, text] of Object.entries(samples)) {
		await writeFile(join(copy, name), text);
	}
	let directory = 'src';
	await mkdir(join(copy, directory));
	const directories = [directory];
	for (let depth = 1; depth <= 12; depth++) {
		directory += `/level${String(depth).padStart(2, '0')}`;
		await mkdir(join(copy, directory));
		directories.push(directory);
	}
	const leaf = `${directory}/中文 @ 文件.ts`;
	await writeFile(join(copy, leaf), 'export const version = 1;\n');
	await mkdir(join(copy, 'bulk'));
	for (let index = 0; index < 500; index++) {
		await writeFile(join(copy, 'bulk', `item-${String(index).padStart(3, '0')}.json`), '{}\n');
	}
	svn('add', '--force', `${copy}@`);
	svn('commit', `${copy}@`, '-m', '真实目录树与类型文件');
	await writeFile(join(copy, leaf), 'export const version = 2;\n');
	await writeFile(join(copy, 'README.md'), '# 仓盒\n紧凑文件视图\n');
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: join(root, 'data') },
	});
	page = await instance.firstWindow();
	page.on('pageerror', (error) => errors.push(error.message));
	await instance.evaluate(({ app }) => app.focus({ steal: true }));
	await page.bringToFront();
	await page.waitForSelector('.welcome');
	await instance.evaluate(({ dialog }, copy) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [copy] });
	}, copy);
	await page.getByRole('button', { name: '添加已有工作副本', exact: true }).click();
	await page.getByRole('button', { name: '中文 @ 文件.ts', exact: true }).waitFor();
	await page.getByRole('checkbox', { name: '仅显示变更', exact: true }).uncheck();
	await page.getByRole('button', { name: 'config.json', exact: true }).waitFor();
	const geometry = await page.locator('.file-row').evaluateAll((rows) =>
		rows.map((row) => ({
			path: row.dataset.path,
			depth: Number(row.dataset.depth),
			height: row.getBoundingClientRect().height,
			icon: row.querySelector('.file-type-icon').getBoundingClientRect().left - row.getBoundingClientRect().left,
			text: row.querySelector('.file-label').getBoundingClientRect().left - row.getBoundingClientRect().left,
			type: row.querySelector('.file-type-icon').dataset.fileType,
		})),
	);
	for (const row of geometry) {
		assert.equal(row.height, 26);
		assert.equal(row.icon, 32 + row.depth * 16);
		assert.equal(row.text, 56 + row.depth * 16);
	}
	assert.equal(geometry.find((row) => row.path === 'README.md').icon, geometry.find((row) => row.path === 'src').icon);
	const categories = new Set(geometry.map((row) => row.type));
	for (const type of ['folder', 'typescript', 'json', 'xml', 'stylesheet', 'image', 'archive', 'markdown', 'config']) {
		assert.ok(categories.has(type), `未显示 ${type} 图标`);
	}
	await mkdir(resolve('test-results'), { recursive: true });
	await page.screenshot({ path: resolve('test-results/file-tree-light.png') });
	const alignedWide = await page.evaluate(
		() =>
			Math.abs(
				document.querySelector('.file-table-header .file-columns').children[2].getBoundingClientRect().right -
					document.querySelector('.file-revision').getBoundingClientRect().right,
			) < 1,
	);
	assert.equal(alignedWide, true);
	const fileToolbarHeight = await page.locator('.workspace-toolbar').evaluate((node) => node.getBoundingClientRect().height);
	await page.getByRole('combobox', { name: '文件状态筛选', exact: true }).click();
	await page.getByRole('option', { name: '修改', exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 2);
	assert.equal(await page.locator('.file-row[data-depth="0"]').count(), 2);
	assert.equal(await page.locator('.file-entry .tree-disclosure').count(), 0);
	await page.getByRole('tab', { name: '文件', exact: true }).focus();
	await page.keyboard.press('ArrowRight');
	await page.waitForSelector('.history-commit');
	assert.equal(await page.locator('.workspace-toolbar').evaluate((node) => node.getBoundingClientRect().height), fileToolbarHeight);
	const toolbarControls = await page.locator('.history-filter').evaluate((node) => ({
		search: node.querySelector('.inline-search').getBoundingClientRect().height,
		refresh: node.querySelector('.history-refresh').getBoundingClientRect().height,
	}));
	assert.equal(toolbarControls.search, toolbarControls.refresh);
	assert.equal(
		await page
			.locator('.history-commit')
			.first()
			.evaluate((row) => row.getBoundingClientRect().height),
		54,
	);
	assert.ok((await page.locator('.timeline-row').count()) < 100, '历史路径列表也应虚拟化');
	await page.getByRole('tab', { name: '历史', exact: true }).focus();
	await page.keyboard.press('ArrowLeft');
	await page.waitForFunction(() => document.querySelectorAll('.file-row').length === 2);
	assert.equal(await page.locator('.file-row').evaluateAll((rows) => rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top), 26);
	await page.getByRole('combobox', { name: '文件状态筛选', exact: true }).click();
	await page.getByRole('option', { name: '全部状态', exact: true }).click();
	await page.getByRole('button', { name: 'config.json', exact: true }).waitFor();
	await page.getByRole('button', { name: '中文 @ 文件.ts', exact: true }).click();
	await page.waitForSelector('.file-row.selected[data-depth="14"]');
	let selected = page.locator('.file-row.selected');
	assert.equal(await selected.getAttribute('data-path'), leaf);
	const deepIcon = await selected.locator('.file-type-icon').evaluate((icon) => icon.getBoundingClientRect().left - icon.closest('.file-row').getBoundingClientRect().left);
	assert.equal(deepIcon, 32 + 14 * 16);
	await page.keyboard.press('ArrowLeft');
	await page.waitForSelector('.file-row.selected[data-depth="13"]');
	assert.equal(await page.locator('.file-row.selected').getAttribute('data-path'), directory);
	await page.keyboard.press('ArrowLeft');
	await page.getByRole('button', { name: `展开 ${directory}`, exact: true }).waitFor();
	assert.equal(await page.getByRole('button', { name: '中文 @ 文件.ts', exact: true }).count(), 0);
	await page.keyboard.press('ArrowRight');
	await page.getByRole('button', { name: `收起 ${directory}`, exact: true }).waitFor();
	await page.keyboard.press('ArrowRight');
	await page.waitForSelector('.file-row.selected[data-depth="14"]');
	await page.getByRole('button', { name: '收起差异预览', exact: true }).waitFor();
	await page.getByRole('button', { name: '收起差异预览', exact: true }).click();
	await page.getByRole('button', { name: '设置', exact: false }).first().click();
	await page.getByRole('button', { name: '灰色', exact: true }).click();
	await page.getByRole('button', { name: '关闭', exact: true }).first().click();
	await page.locator('.file-pane').focus();
	await page.keyboard.press('Home');
	await page.waitForSelector('.file-row.selected[data-depth="0"]');
	await page.getByRole('button', { name: '收起差异预览', exact: true }).waitFor();
	await page.getByRole('button', { name: '收起差异预览', exact: true }).click();
	await page.locator('.diff-view').waitFor({ state: 'hidden' });
	await page.screenshot({ path: resolve('test-results/file-tree-dark.png') });
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }));
	const list = page.getByRole('list', { name: '工作副本文件', exact: true });
	await list.evaluate((element) => {
		element.scrollLeft = 80;
	});
	await page.waitForFunction(() => document.querySelector('.file-table-header').scrollLeft === document.querySelector('[aria-label="工作副本文件"]').scrollLeft);
	const columnsAligned = await page.evaluate(() => {
		const header = document.querySelector('.file-table-header .file-columns').children[2].getBoundingClientRect();
		const row = document.querySelector('.file-revision').getBoundingClientRect();
		return Math.abs(header.right - row.right) < 1;
	});
	assert.equal(columnsAligned, true);
	await list.evaluate((element) => {
		element.scrollLeft = 0;
	});
	await page.screenshot({ path: resolve('test-results/file-tree-compact.png') });
	await page.getByRole('button', { name: '展开 bulk', exact: true }).click();
	await page.getByRole('button', { name: 'item-000.json', exact: true }).waitFor();
	assert.ok((await list.getByRole('listitem').count()) < 100, '500 个文件应仅渲染可见窗口');
	await list.evaluate((element) => {
		element.scrollTop = 8000;
	});
	await page.waitForFunction(() => [...document.querySelectorAll('.file-row')].some((row) => row.dataset.path?.startsWith('bulk/item-2')));
	const stripes = await list.getByRole('listitem').evaluateAll((rows) => rows.map((row) => ({ parity: row.dataset.parity, top: Number.parseFloat(row.style.top) })));
	for (const row of stripes) {
		assert.equal(row.parity, Math.round(row.top / 26) % 2 ? 'odd' : 'even');
	}
	assert.equal(errors.length, 0, errors.join('\n'));
	console.log(
		JSON.stringify(
			{
				result: 'passed',
				rowHeight: 26,
				indent: 16,
				depth: 14,
				files: 500,
				checks: [
					'同层目录与文件严格对齐',
					'14 层缩进无封顶',
					'多文件类型图标',
					'方向键父子导航与折叠',
					'浅深色及小窗口',
					'横向滚动表头同步',
					'状态筛选平铺对齐',
					'文件历史切换后的行高',
					'真实大列表虚拟化',
					'滚动条纹稳定',
				],
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(error);
	console.error(
		await page
			?.evaluate(() =>
				['.file-table-header', '[aria-label="工作副本文件"]'].map((selector) => {
					const element = document.querySelector(selector);
					return { selector, width: element?.clientWidth, scrollWidth: element?.scrollWidth, scrollLeft: element?.scrollLeft };
				}),
			)
			.catch(() => []),
	);
	await page?.screenshot({ path: resolve('test-results/file-tree-failure.png') }).catch(() => {});
	throw error;
} finally {
	await instance?.close().catch(() => {});
	await rm(root, { recursive: true, force: true });
}
