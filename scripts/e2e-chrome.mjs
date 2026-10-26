import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const data = await mkdtemp(join(tmpdir(), 'svnbox-chrome-'));
const output = resolve('test-results');
const errors = [];
const checks = [];
let instance;
let page;

async function inspect(label) {
	const geometry = await page.evaluate(() => {
		const header = document.querySelector('.titlebar-sidebar');
		const sidebar = document.querySelector('.sidebar');
		const divider = document.querySelector('.sidebar-divider');
		const resizer = document.querySelector('.sidebar-resizer');
		const statusbar = document.querySelector('.statusbar');
		const headerRect = header.getBoundingClientRect();
		const sidebarRect = sidebar.getBoundingClientRect();
		const dividerRect = divider.getBoundingClientRect();
		const resizerRect = resizer.getBoundingClientRect();
		return {
			headerEdge: headerRect.right - parseFloat(getComputedStyle(header).borderRightWidth),
			sidebarEdge: sidebarRect.right,
			dividerX: dividerRect.x,
			dividerRight: dividerRect.right,
			resizerEdge: resizerRect.x + (resizerRect.width - dividerRect.width) / 2,
			resizerBottom: resizerRect.bottom,
			statusbarTop: statusbar.getBoundingClientRect().top,
			indicatorColor: getComputedStyle(resizer, '::before').backgroundColor,
			indicatorHeight: parseFloat(getComputedStyle(resizer, '::before').height),
			keyboardFocused: resizer.matches(':focus-visible'),
			sidebarY: sidebarRect.y,
			viewportWidth: innerWidth,
		};
	});
	assert.equal(geometry.headerEdge, geometry.sidebarEdge, `${label}: 标题栏与侧栏边缘对齐`);
	assert.equal(geometry.dividerX, geometry.sidebarEdge, `${label}: 分隔线紧邻侧栏`);
	assert.equal(geometry.resizerEdge, geometry.dividerX, `${label}: 拖动热区与静止分隔线对齐`);
	assert.equal(geometry.resizerBottom, geometry.statusbarTop, `${label}: 拖动热区不延伸到状态栏`);
	if (geometry.keyboardFocused) {
		assert.ok(geometry.indicatorHeight <= 24, `${label}: 键盘焦点只显示短小提示`);
	} else {
		assert.equal(geometry.indicatorColor, 'rgba(0, 0, 0, 0)', `${label}: 悬停和拖动不显示彩色高亮`);
	}

	const pixels = await instance.evaluate(async ({ BrowserWindow }, geometry) => {
		const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
		const size = image.getSize();
		const bitmap = image.toBitmap();
		const scale = size.width / geometry.viewportWidth;

		function pixel(x, y) {
			const offset = (Math.floor(y * scale) * size.width + Math.floor(x * scale)) * 4;
			return [...bitmap.subarray(offset, offset + 4)];
		}

		const lineX = (geometry.dividerX + geometry.dividerRight) / 2;
		return {
			header: pixel(120, 12),
			sidebar: pixel(10, geometry.sidebarY + 26),
			topLine: pixel(lineX, 20),
			bottomLine: pixel(lineX, geometry.sidebarY + 26),
		};
	}, geometry);
	assert.deepEqual(pixels.header, pixels.sidebar, `${label}: 左上角与侧栏的实际像素颜色一致`);
	assert.deepEqual(pixels.topLine, pixels.bottomLine, `${label}: 上下分隔线的实际像素颜色一致`);
	checks.push(label);
}

async function drag(delta) {
	const resizer = page.getByRole('separator', { name: '调整导航宽度' });
	const bounds = await resizer.boundingBox();
	const start = bounds.x + bounds.width / 2;
	const previous = Number(await resizer.getAttribute('aria-valuenow'));
	await page.mouse.move(start, 300);
	await page.mouse.down();
	await page.mouse.move(start + delta, 300, { steps: 8 });
	const expected = Math.min(380, Math.max(204, previous + delta));
	await page.waitForFunction((width) => Number(document.querySelector('.sidebar-resizer').getAttribute('aria-valuenow')) === width, expected);
	await inspect(`拖动中 ${expected}px`);
	await page.mouse.up();
	await page.mouse.move(700, 400);
	await inspect(`松开并移开鼠标 ${expected}px`);
}

try {
	await mkdir(output, { recursive: true });
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: data },
	});
	page = await instance.firstWindow();
	page.setDefaultTimeout(10000);
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForSelector('.sidebar');
	const settings = await page.evaluate(async () => (await window.svnbox.call('state')).settings);
	for (const theme of ['sunset', 'light', 'dark', 'ocean', 'mint', 'iris']) {
		await page.evaluate((settings) => window.svnbox.call('settings', settings), { ...settings, theme });
		await page.reload();
		await page.waitForSelector(`:root[data-theme="${theme}"] .sidebar`);
		await page.mouse.move(700, 400);
		await inspect(`${theme} 静止`);
		await drag(60);
		await drag(-1000);
		await drag(1000);
		const resizer = page.getByRole('separator', { name: '调整导航宽度' });
		await resizer.press('Home');
		assert.equal(await resizer.getAttribute('aria-valuenow'), '204');
		await inspect(`${theme} 键盘最小宽度`);
		await resizer.press('End');
		assert.equal(await resizer.getAttribute('aria-valuenow'), '380');
		await resizer.press('ArrowLeft');
		assert.equal(await resizer.getAttribute('aria-valuenow'), '372');
		await inspect(`${theme} 键盘调整`);
		await page.locator('.sidebar-search input').focus();
		await page.emulateMedia({ contrast: 'more' });
		await inspect(`${theme} 提高对比度`);
		await page.emulateMedia({ contrast: 'no-preference' });
		await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 680));
		await inspect(`${theme} 最小窗口`);
		await page.screenshot({ path: join(output, `chrome-${theme}.png`) });
		await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 940));
	}
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ result: 'passed', checks }, null, 2));
} catch (error) {
	await page?.screenshot({ path: join(output, 'chrome-failure.png') }).catch(() => {});
	throw error;
} finally {
	await instance?.close().catch(() => {});
	await rm(data, { recursive: true, force: true });
}
