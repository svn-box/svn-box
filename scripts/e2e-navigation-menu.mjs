import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), 'svnbox-navigation-menu-'));
const repository = join(root, 'repository');
const copies = [join(root, '项目甲'), join(root, '项目乙')];
let instance;
let page;
const errors = [];

async function call(method, input) {
	return page.evaluate(async ({ method, input }) => window.svnbox.call(method, input), { method, input });
}

async function waitUntil(predicate) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('导航操作没有及时完成');
}

async function checkSidebarAlignment() {
	const geometry = await page.evaluate(() => {
		const titlebar = document.querySelector('.titlebar');
		const header = document.querySelector('.titlebar-sidebar');
		const divider = document.querySelector('.sidebar-divider');
		const handle = document.querySelector('[aria-label="调整导航宽度"]').getBoundingClientRect();
		const main = document.querySelector('.main-area');
		const headerBounds = header.getBoundingClientRect();
		const mainBounds = main.getBoundingClientRect();
		const dividerBounds = divider.getBoundingClientRect();
		const line = getComputedStyle(titlebar, '::after');
		return {
			headerEdge: headerBounds.right,
			mainEdge: mainBounds.left,
			headerLine: headerBounds.right - parseFloat(getComputedStyle(header).borderRightWidth),
			bodyLine: dividerBounds.left,
			horizontalLine: titlebar.getBoundingClientRect().left + parseFloat(line.left),
			leftBottomBorder: getComputedStyle(titlebar).borderBottomWidth,
			branding: header.textContent.trim() || header.querySelector('svg, img, .brand') !== null,
			handleTop: handle.top,
			handleBottom: handle.bottom,
			statusbarTop: document.querySelector('.statusbar').getBoundingClientRect().top,
		};
	});
	assert.ok(Math.abs(geometry.headerEdge - geometry.mainEdge) < 0.5, '标题栏与工作区内容起点应对齐');
	assert.ok(Math.abs(geometry.headerLine - geometry.bodyLine) < 0.5, '上下竖线应重合');
	assert.ok(Math.abs(geometry.horizontalLine - geometry.mainEdge) < 0.5, '横线只应从主工作区开始');
	assert.equal(geometry.leftBottomBorder, '0px');
	assert.equal(geometry.branding, false);
	assert.equal(geometry.handleTop, 0);
	assert.equal(geometry.handleBottom, geometry.statusbarTop);
}

try {
	execFileSync('/opt/homebrew/bin/svnadmin', ['create', repository]);
	const url = pathToFileURL(repository).href;
	execFileSync('/opt/homebrew/bin/svn', ['mkdir', `${url}/trunk`, '-m', '导航菜单测试']);
	for (const path of copies) {
		execFileSync('/opt/homebrew/bin/svn', ['checkout', `${url}/trunk`, path]);
	}
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: join(root, 'data') },
	});
	page = await instance.firstWindow();
	await instance.evaluate(({ app }) => app.focus({ steal: true }));
	await page.bringToFront();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForSelector('.welcome');
	for (const path of copies) {
		await call('addWorkingCopy', { path });
	}
	let state = await call('manage', { entity: 'group', name: '测试分组' });
	await call('bookmark', { repositoryId: state.repositories[0].id, url: `${url}/trunk`, name: '主干路径' });
	await page.reload();
	await page.waitForSelector('.project-header');
	const first = page.locator('.repository-children .nav-copy-main').filter({ hasText: '项目甲' });
	const second = page.locator('.repository-children .nav-copy-main').filter({ hasText: '项目乙' });
	state = await call('state');
	const firstId = state.workingCopies[0].id;
	const secondId = state.workingCopies[1].id;
	await second.click();
	await checkSidebarAlignment();
	const columns = await page.evaluate(() => {
		const iconLeft = (selector) => document.querySelector(selector).getBoundingClientRect().left;
		return {
			icons: ['.repository-name > svg', '.repository-children .project-icon > svg', '.remote-bookmark svg'].map(iconLeft),
			labels: ['.repository-name > span', '.repository-children .nav-copy-text strong', '.repository-children .nav-copy-text small', '.remote-bookmark button > span'].map(
				iconLeft,
			),
		};
	});
	assert.ok(Math.max(...columns.icons) - Math.min(...columns.icons) < 0.5, '导航图标应共用对齐列');
	assert.ok(Math.max(...columns.labels) - Math.min(...columns.labels) < 0.5, '导航名称和路径应共用文字起点');
	const divider = page.getByRole('separator', { name: '调整导航宽度', exact: true });
	const initialWidth = Number(await divider.getAttribute('aria-valuenow'));
	const dividerBounds = await divider.boundingBox();
	await page.mouse.move(dividerBounds.x + dividerBounds.width / 2, 12);
	await page.mouse.down();
	await page.mouse.move(dividerBounds.x + 48, 12, { steps: 4 });
	await page.mouse.up();
	assert.ok(Number(await divider.getAttribute('aria-valuenow')) > initialWidth + 40, '标题栏位置应能调整分栏宽度');
	await checkSidebarAlignment();
	const nextBounds = await divider.boundingBox();
	const widthBeforeBottomDrag = Number(await divider.getAttribute('aria-valuenow'));
	const bottom = nextBounds.y + nextBounds.height - 8;
	await page.mouse.move(nextBounds.x + nextBounds.width / 2, bottom);
	await page.mouse.down();
	await page.mouse.move(nextBounds.x - 24, bottom, { steps: 4 });
	await page.mouse.up();
	assert.ok(Number(await divider.getAttribute('aria-valuenow')) < widthBeforeBottomDrag - 20, '窗口底部应能调整分栏宽度');
	await checkSidebarAlignment();
	await divider.focus();
	await page.keyboard.press('Home');
	assert.equal(Number(await divider.getAttribute('aria-valuenow')), 204);
	await checkSidebarAlignment();
	await page.keyboard.press('End');
	assert.equal(Number(await divider.getAttribute('aria-valuenow')), 380);
	await checkSidebarAlignment();
	await page.keyboard.press('ArrowLeft');
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1100, height: 760 }));
	await checkSidebarAlignment();
	await mkdir(resolve('test-results'), { recursive: true });
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	});
	await page.mouse.move(700, 400);
	await page.screenshot({ path: resolve('test-results/sidebar-corner-aligned.png'), clip: { x: 0, y: 0, width: 460, height: 430 } });
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1440, height: 940 }));
	await checkSidebarAlignment();
	const geometry = await page.locator('.nav-copy.active').evaluate((row) => {
		const bounds = row.getBoundingClientRect();
		const navigation = document.querySelector('.navigation-scroll');
		const container = navigation.getBoundingClientRect();
		const children = document.querySelector('.repository-children');
		return {
			left: bounds.left - container.left,
			right: bounds.right - container.right,
			border: getComputedStyle(children).borderLeftWidth,
			overflow: navigation.scrollWidth > navigation.clientWidth,
		};
	});
	assert.ok(Math.abs(geometry.left) <= 1 && Math.abs(geometry.right) <= 1, '选中背景应铺满侧栏宽度');
	assert.equal(geometry.border, '0px');
	assert.equal(geometry.overflow, false);
	await first.click({ button: 'right' });
	const copyMenu = page.getByRole('menu', { name: '工作副本 项目甲', exact: true });
	await copyMenu.waitFor();
	assert.equal((await call('state')).activeId, secondId, '右键不能切换当前项目');
	assert.equal(await page.getByRole('menuitem', { name: '浏览远端路径', exact: true }).count(), 0);
	await mkdir(resolve('test-results'), { recursive: true });
	await copyMenu.getByRole('menuitem', { name: '刷新本地状态', exact: true }).hover();
	await page.screenshot({ path: resolve('test-results/navigation-menu-light.png') });
	await copyMenu.getByRole('menuitem', { name: '收藏工作副本', exact: true }).click();
	await waitUntil(async () => (await call('state')).workingCopies.find((copy) => copy.id === firstId).favorite);
	state = await call('state');
	assert.equal(state.workingCopies.find((copy) => copy.id === secondId).favorite, false);
	assert.equal(state.activeId, secondId);
	const favorite = page.locator('.nav-copy.shortcut .nav-copy-main').filter({ hasText: '项目甲' });
	await favorite.click({ button: 'right' });
	await copyMenu.getByRole('menuitem', { name: '取消收藏', exact: true }).waitFor();
	await page.keyboard.press('Escape');
	await copyMenu.waitFor({ state: 'hidden' });
	await waitUntil(() => favorite.evaluate((node) => document.activeElement === node));
	assert.equal(await favorite.evaluate((node) => document.activeElement === node), true, 'Escape 应恢复行焦点');
	await first.focus();
	await page.keyboard.press('Shift+F10');
	await copyMenu.waitFor();
	await page.keyboard.press('ArrowDown');
	assert.equal(await copyMenu.locator('[data-highlighted]').count(), 1);
	await page.keyboard.press('Escape');
	await waitUntil(() => first.evaluate((node) => document.activeElement === node));
	assert.equal(await first.evaluate((node) => document.activeElement === node), true);
	await page.keyboard.press('ContextMenu');
	await copyMenu.waitFor();
	await page.keyboard.press('Escape');
	const repo = page.locator('.repository-name').first();
	await repo.click({ button: 'right' });
	await page.getByRole('menuitem', { name: '浏览远端路径', exact: true }).waitFor();
	assert.equal(await page.getByRole('heading', { name: '仓库浏览与检出', exact: true }).count(), 0);
	await page.keyboard.press('Escape');
	const disclosure = page.locator('.repository-disclosure').first();
	await disclosure.click();
	assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
	await disclosure.click();
	const bookmark = page.locator('.remote-bookmark').filter({ hasText: '主干路径' });
	await bookmark.click({ button: 'right' });
	await page.getByRole('menuitem', { name: '重命名路径…', exact: true }).click();
	const name = page.getByRole('textbox', { name: '路径书签名称', exact: true });
	await name.waitFor();
	assert.equal(await name.evaluate((node) => document.activeElement === node), true);
	await name.fill('右键重命名');
	await name.press('Enter');
	await waitUntil(async () => (await call('state')).bookmarks[0].name === '右键重命名');
	await page.getByRole('heading', { name: '分组 测试分组', exact: true }).click({ button: 'right' });
	await page.getByRole('menuitem', { name: '管理分组…', exact: true }).waitFor();
	await page.keyboard.press('Escape');
	assert.equal(await page.locator('.navigation-scroll .nav-more').count(), 0);
	assert.equal(await page.getByRole('button', { name: '添加项目', exact: true }).isVisible(), true);
	await call('settings', { theme: 'dark' });
	await page.reload();
	await page.waitForSelector('.project-header');
	await page.locator('.repository-children .nav-copy-main').filter({ hasText: '项目甲' }).click({ button: 'right' });
	await page.getByRole('menu', { name: '工作副本 项目甲', exact: true }).waitFor();
	const bounds = await page.getByRole('menu', { name: '工作副本 项目甲', exact: true }).boundingBox();
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
	await page.getByRole('menuitem', { name: '刷新本地状态', exact: true }).hover();
	await page.screenshot({ path: resolve('test-results/navigation-context-menu.png') });
	await page.screenshot({
		path: resolve('test-results/navigation-menu-detail.png'),
		clip: { x: Math.max(0, bounds.x - 20), y: Math.max(0, bounds.y - 18), width: bounds.width + 40, height: bounds.height + 44 },
	});
	await page.keyboard.press('Escape');
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 1000, height: 680 }));
	await divider.focus();
	await page.keyboard.press('End');
	const detailsDivider = page.getByRole('separator', { name: '调整详情宽度', exact: true });
	const detailsBounds = await detailsDivider.boundingBox();
	const dividerColor = await detailsDivider.evaluate((node) => getComputedStyle(node).backgroundColor);
	await page.mouse.move(detailsBounds.x, detailsBounds.y + 70);
	assert.equal(await detailsDivider.evaluate((node) => getComputedStyle(node).backgroundColor), dividerColor, '详情分隔线悬停时不高亮');
	await page.mouse.down();
	await page.mouse.move(detailsBounds.x - 180, detailsBounds.y + 70, { steps: 6 });
	assert.equal(await detailsDivider.evaluate((node) => getComputedStyle(node).backgroundColor), dividerColor, '详情分隔线拖动时不高亮');
	await page.mouse.up();
	const controlsFit = await page.evaluate(() => {
		const header = document.querySelector('.titlebar').getBoundingClientRect();
		const pane = document.querySelector('.file-pane').getBoundingClientRect();
		const toolbar = document.querySelector('.workspace-toolbar').getBoundingClientRect();
		const headerButtons = [...document.querySelectorAll('.titlebar button')];
		const browserControls = [...document.querySelector('.workspace-toolbar').children];
		return {
			header: headerButtons.every((node) => {
				const box = node.getBoundingClientRect();
				return box.right <= header.right && box.top >= header.top && box.bottom <= header.bottom;
			}),
			browser: browserControls.every((node) => {
				const box = node.getBoundingClientRect();
				return box.left >= pane.left && box.right <= pane.right && box.bottom <= toolbar.bottom;
			}),
			page: document.documentElement.scrollWidth <= innerWidth,
		};
	});
	assert.deepEqual(controlsFit, { header: true, browser: true, page: true }, '最小窗口和最大面板宽度下，操作控件仍应可见');
	await page.screenshot({ path: resolve('test-results/apple-minimum-window.png') });
	assert.deepEqual(errors, []);
	console.log(
		JSON.stringify(
			{
				result: 'passed',
				checks: [
					'工作副本与收藏右键菜单',
					'右键目标隔离',
					'右键不切换项目',
					'Shift+F10 与菜单键',
					'方向键与 Escape 焦点恢复',
					'仓库右键不打开远端',
					'左键展开折叠',
					'路径重命名及输入焦点',
					'分组右键',
					'保留添加按钮',
					'深色与弹层边界',
					'整行选中铺满侧栏',
					'无竖线与横向溢出',
					'标题栏与导航分隔线重合',
					'左侧无标题横线和标识',
					'导航图标与名称路径对齐',
					'拖动及窄窗口分界对齐',
					'顶端和底部都能调整分栏',
					'分栏支持键盘调整',
					'最小窗口和最大面板下工具栏自动换行',
				],
			},
			null,
			2,
		),
	);
} finally {
	await instance?.close();
	await rm(root, { recursive: true, force: true });
}
