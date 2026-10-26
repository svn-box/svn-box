import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, connect } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-readme-')));
const repositories = join(root, 'Repositories');
const projects = join(root, 'Projects');
const output = resolve('resources/screenshots');
const targets = new Set(process.argv.slice(2));
const selectedPath = 'src/components/WorkingCopyList.tsx';
const errors = [];
const screenshots = [];
const size = { width: 1920, height: 1200 };
let instance;
let page;
let server;

function svn(...args) {
	return execFileSync('/opt/homebrew/bin/svn', ['--non-interactive', ...args], { encoding: 'utf8' });
}

async function file(path, content) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

async function revision(repository, author, date) {
	const number = Number(execFileSync('/opt/homebrew/bin/svnlook', ['youngest', repository], { encoding: 'utf8' }).trim());
	for (const [property, value] of [
		['svn:author', author],
		['svn:date', `${date}.000000Z`],
	]) {
		const path = join(root, property.replace(':', '-'));
		await writeFile(path, value);
		execFileSync('/opt/homebrew/bin/svnadmin', ['setrevprop', repository, '-r', String(number), property, path]);
	}
	return number;
}

async function createRepository(name) {
	const path = join(repositories, name);
	execFileSync('/opt/homebrew/bin/svnadmin', ['create', path]);
	await writeFile(join(path, 'conf/svnserve.conf'), '[general]\nanon-access = read\nauth-access = write\npassword-db = passwd\nrealm = svnbox-readme-demo\n');
	await writeFile(join(path, 'conf/passwd'), '[users]\ndemo = temporary-demo-only\n');
	const url = pathToFileURL(path).href;
	svn('mkdir', `${url}/trunk`, `${url}/branches`, `${url}/tags`, '-m', '建立项目目录');
	await revision(path, 'Lin', '2026-10-16T08:30:00');
	return { path, url };
}

async function serve() {
	const port = await new Promise((resolve) => {
		const socket = createServer();
		socket.listen(0, '127.0.0.1', () => {
			const port = socket.address().port;
			socket.close(() => resolve(port));
		});
	});
	server = spawn('/opt/homebrew/bin/svnserve', ['--daemon', '--foreground', '--listen-host', '127.0.0.1', '--listen-port', String(port), '--root', repositories], {
		stdio: 'ignore',
	});
	for (let attempt = 0; attempt < 60; attempt++) {
		const ready = await new Promise((resolve) => {
			const socket = connect(port, '127.0.0.1');
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => resolve(false));
		});
		if (ready) {
			return `svn://127.0.0.1:${port}`;
		}
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error('The isolated screenshot SVN server did not start.');
}

function workingCopyList(updated) {
	return `import { Folder, Star } from 'lucide-react';
import type { WorkingCopy } from '../types';

type Props = {
  copies: WorkingCopy[];
  activeId: string;
  onSelect: (id: string) => void;
};

export function WorkingCopyList({ copies, activeId, onSelect }: Props) {
${updated ? '  const favorites = copies.filter((copy) => copy.favorite);\n  const projects = copies.filter((copy) => !copy.favorite);\n' : ''}  return (
    <nav aria-label="工作副本">
${updated ? '      <ProjectGroup title="收藏" icon={Star} copies={favorites} />\n      <ProjectGroup title="所有项目" icon={Folder} copies={projects} />' : '      <h2>所有项目</h2>'}
      {copies.map((copy) => (
        <button
          key={copy.id}
          className={copy.id === activeId ? 'selected' : ''}
          onClick={() => onSelect(copy.id)}
${updated ? "          aria-current={copy.id === activeId ? 'page' : undefined}\n" : ''}        >
          <Folder size={16} />
          <span>{copy.name}</span>
${updated ? '          <ChangeCount value={copy.changeCount} />' : '          <span>{copy.path}</span>'}
        </button>
      ))}
    </nav>
  );
}
`;
}

async function fixtures() {
	await mkdir(repositories, { recursive: true });
	await mkdir(projects, { recursive: true });
	const atlas = await createRepository('atlas-desktop');
	const seed = join(root, 'seed');
	svn('checkout', `${atlas.url}/trunk`, seed);
	const files = {
		'README.md': '# Atlas Desktop\n\nA focused workspace for creative teams.\n\n## Workspace\nManage projects, review changes, and keep your work moving.\n',
		'package.json': '{\n  "name": "atlas-desktop",\n  "version": "0.1.0",\n  "private": true\n}\n',
		'src/components/WorkingCopyList.tsx': workingCopyList(false),
		'src/components/CommitPanel.tsx':
			'export function CommitPanel() {\n  return <section aria-label="提交审阅">\n    <h2>准备提交</h2>\n    <p>确认本次提交的文件。</p>\n  </section>;\n}\n',
		'src/components/HistoryTimeline.tsx': 'export const historyOptions = {\n  pageSize: 20,\n  groupByDate: false,\n  showChangedPaths: true,\n};\n',
		'src/components/Inspector.tsx': 'export const inspectorTabs = ["information", "properties"];\n',
		'src/lib/session.ts': 'export const sessionDefaults = {\n  view: "files",\n  rememberSelection: false,\n};\n',
		'src/lib/path.ts': 'export const displayPath = (path: string) => path.replaceAll("\\\\", "/");\n',
		'src/styles/tokens.css': ':root {\n  --accent: #4263eb;\n  --sidebar: #152b4d;\n  --row-height: 28px;\n}\n',
		'src/styles/workspace.css': '.workspace { display: grid; grid-template-columns: 260px 1fr; }\n',
		'src/main/svn.ts': 'export const processOptions = {\n  timeout: 30_000,\n  maxConcurrentReads: 2,\n};\n',
		'src/App.tsx': 'export function App() {\n  return <Workspace title="Atlas Desktop" />;\n}\n',
		'docs/keyboard-shortcuts.md': '# Keyboard shortcuts\n\n- Command+O: Open a project\n- Command+R: Refresh\n',
		'docs/发布说明.md': '# 0.1.0 发布计划\n\n多项目管理、变更审阅与历史时间线。\n',
		'assets/legacy-logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#4263eb"/></svg>\n',
		'build/entitlements.mac.plist': '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n',
		'config/defaults.json': '{"language":"zh-CN","theme":"ocean"}\n',
		'locales/zh-CN.json': '{"workspace":"工作空间","projects":"项目"}\n',
		'public/manifest.json': '{"name":"Atlas Desktop","short_name":"Atlas"}\n',
		'scripts/check-release.mjs': 'console.log("Checking release artifacts…");\n',
		'tests/session.test.ts': 'export const fixture = { activeId: "atlas", draft: "" };\n',
		LICENSE: 'Atlas Desktop demo project. Fictional content for svnbox screenshots.\n',
		'.editorconfig': 'root = true\n\n[*]\ncharset = utf-8\nindent_style = space\nindent_size = 2\n',
		'.gitignore': 'node_modules/\nout/\nrelease/\n',
		'components.json': '{"style":"compact","icons":"lucide"}\n',
		'electron.vite.config.ts': 'export default { main: {}, preload: {}, renderer: {} };\n',
		'tsconfig.json': '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}\n',
	};
	for (const [path, content] of Object.entries(files)) {
		await file(join(seed, path), content);
	}
	svn('add', '--force', `${seed}@`);
	svn('commit', `${seed}@`, '-m', '搭建 Atlas Desktop 工作空间\n\n加入项目导航、提交面板与文件详情。');
	await revision(atlas.path, 'Lin', '2026-10-17T03:20:00');
	const commits = [
		['src/styles/workspace.css', '.workspace { display: grid; grid-template-columns: 280px minmax(0, 1fr); }\n', '统一工作空间布局与分栏宽度', 'Maya', '2026-10-19T06:45:00'],
		[
			'docs/keyboard-shortcuts.md',
			'# Keyboard shortcuts\n\n- Command+O: Open a project\n- Command+R: Refresh\n- Command+Return: Review a commit\n',
			'补充键盘快捷键与使用说明',
			'Chen',
			'2026-10-21T02:15:00',
		],
		['src/components/Inspector.tsx', 'export const inspectorTabs = ["information", "properties", "history"];\n', '在详情面板中加入路径历史入口', 'Lin', '2026-10-22T08:10:00'],
		['src/main/svn.ts', 'export const processOptions = {\n  timeout: 60_000,\n  maxConcurrentReads: 3,\n};\n', '改善后台查询与长任务响应', 'Alex', '2026-10-23T09:35:00'],
		[
			'src/styles/tokens.css',
			':root {\n  --accent: #3868d9;\n  --sidebar: #152b4d;\n  --row-height: 26px;\n}\n',
			'调整紧凑列表与深蓝工作空间配色',
			'Maya',
			'2026-10-24T07:40:00',
		],
	];
	for (const [path, content, message, author, date] of commits) {
		await writeFile(join(seed, path), content);
		svn('commit', `${seed}@`, '-m', message);
		await revision(atlas.path, author, date);
	}
	await writeFile(
		join(seed, 'src/components/HistoryTimeline.tsx'),
		'export const historyOptions = {\n  pageSize: 30,\n  groupByDate: true,\n  showChangedPaths: true,\n  inlineComparison: true,\n};\n',
	);
	await writeFile(join(seed, 'src/lib/session.ts'), 'export const sessionDefaults = {\n  view: "files",\n  rememberSelection: true,\n  restoreCommitDraft: true,\n};\n');
	svn('commit', `${seed}@`, '-m', '完善历史时间线与项目会话恢复\n\n按日期组织提交，支持在每条记录中查看差异。\n切换项目后保留选择和提交草稿。');
	const latest = await revision(atlas.path, 'Lin', '2026-10-26T02:42:00');
	svn('copy', `${atlas.url}/trunk`, `${atlas.url}/branches/release-0.1`, '-m', '创建 0.1 发布分支');
	await revision(atlas.path, 'Chen', '2026-10-26T03:00:00');
	svn('copy', `${atlas.url}/trunk`, `${atlas.url}/tags/v0.1.0-preview`, '-m', '标记首个预览版本');
	await revision(atlas.path, 'Chen', '2026-10-26T03:10:00');
	for (const name of ['interface-kit', 'product-docs']) {
		const repository = await createRepository(name);
		const path = join(root, `seed-${name}`);
		svn('checkout', `${repository.url}/trunk`, path);
		await file(join(path, 'README.md'), `# ${name === 'interface-kit' ? 'Interface Kit' : 'Atlas Documentation'}\n\nShared resources for the Atlas team.\n`);
		await file(
			join(path, name === 'interface-kit' ? 'tokens/colors.json' : 'guides/getting-started.md'),
			name === 'interface-kit' ? '{"accent":"#3868d9"}\n' : '# Getting started\n\nCreate your first workspace.\n',
		);
		svn('add', '--force', `${path}@`);
		svn('commit', `${path}@`, '-m', name === 'interface-kit' ? '建立共享组件与设计变量' : '整理入门指南与产品文档');
		await revision(repository.path, 'Maya', '2026-10-24T01:30:00');
	}
	const base = await serve();
	const copies = [
		{ path: join(projects, 'AtlasDesktop'), name: 'Atlas Desktop', url: `${base}/atlas-desktop/trunk` },
		{ path: join(projects, 'AtlasRelease'), name: 'Atlas · Release 0.1', url: `${base}/atlas-desktop/branches/release-0.1` },
		{ path: join(projects, 'InterfaceKit'), name: 'Interface Kit', url: `${base}/interface-kit/trunk` },
		{ path: join(projects, 'ProductDocs'), name: 'Atlas Docs', url: `${base}/product-docs/trunk` },
	];
	for (const copy of copies) {
		svn('checkout', copy.url, copy.path);
	}
	const main = copies[0].path;
	await writeFile(join(main, selectedPath), workingCopyList(true));
	await writeFile(
		join(main, 'src/components/CommitPanel.tsx'),
		'export function CommitPanel() {\n  return <section aria-label="提交审阅">\n    <h2>审阅本次提交</h2>\n    <p>逐项选择文件，并核对实际影响范围。</p>\n    <DraftStatus autosave />\n  </section>;\n}\n',
	);
	await writeFile(
		join(main, 'src/lib/session.ts'),
		'export const sessionDefaults = {\n  view: "files",\n  rememberSelection: true,\n  restoreCommitDraft: true,\n  keepHistoryContext: true,\n};\n',
	);
	await writeFile(join(main, 'src/styles/tokens.css'), ':root {\n  --accent: #3868d9;\n  --sidebar: #142849;\n  --row-height: 26px;\n  --selection: #e6edff;\n}\n');
	await writeFile(
		join(main, 'README.md'),
		'# Atlas Desktop\n\nA focused workspace for creative teams.\n\n## Workspace\nManage multiple projects, review changes, and restore your session.\n\n## Release 0.1\nA clearer project list and a more confident commit workflow.\n',
	);
	svn('propset', 'svn:keywords', 'Id', `${main}/README.md@`);
	await file(join(main, 'src/components/EmptyState.tsx'), 'export const EmptyState = () => <p>选择项目，开始工作。</p>;\n');
	svn('add', `${main}/src/components/EmptyState.tsx@`);
	svn('move', `${main}/src/lib/path.ts@`, `${main}/src/lib/paths.ts`);
	svn('delete', `${main}/assets/legacy-logo.svg@`);
	await writeFile(
		join(main, 'docs/keyboard-shortcuts.md'),
		'# Keyboard shortcuts\n\n- Command+O: Open a project\n- Command+R: Refresh\n- Command+Return: Review a commit\n- Command+J: Operation logs\n',
	);
	await file(join(main, 'release-plan.md'), '# Release checklist\n\n- Review selected changes\n- Verify project switching\n- Publish preview notes\n');
	await writeFile(join(copies[2].path, 'README.md'), '# Interface Kit\n\nShared components, color tokens, and interaction patterns.\n');
	await writeFile(join(copies[2].path, 'tokens/colors.json'), '{"accent":"#3868d9","success":"#21875d"}\n');
	await file(join(copies[2].path, 'components.json'), '{"style":"compact"}\n');
	await writeFile(join(copies[3].path, 'guides/getting-started.md'), '# Getting started\n\nCreate a workspace, then add your first project.\n');
	await file(join(copies[3].path, 'release-notes.md'), '# 0.1.0\n\nA new home for your projects.\n');
	return { base, copies, latest };
}

async function call(method, input) {
	return page.evaluate(({ method, input }) => window.svnbox.call(method, input), { method, input });
}

async function resize(label, dx, dy) {
	const bounds = await page.getByRole('separator', { name: label, exact: true }).boundingBox();
	assert.ok(bounds, `Missing divider: ${label}`);
	const x = bounds.x + bounds.width / 2;
	const y = bounds.y + bounds.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx, y + dy, { steps: 12 });
	await page.mouse.up();
}

async function settings() {
	await page.getByRole('button', { name: /^设置/ }).click();
	return page.getByRole('dialog', { name: '设置', exact: true });
}

async function theme(id, label) {
	const dialog = await settings();
	await dialog.getByRole('button', { name: label, exact: true }).click();
	await page.waitForFunction((id) => document.documentElement.dataset.theme === id, id);
	await dialog.getByRole('button', { name: '关闭', exact: true }).first().click();
}

async function screenshot(name) {
	if (targets.size && !targets.has(name)) {
		return;
	}
	await page.locator('[data-sonner-toast]').waitFor({ state: 'hidden' });
	await page.waitForFunction(() => !document.querySelector('.spin'));
	await page.evaluate(async () => {
		await document.fonts.ready;
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	});
	assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), size);
	const path = join(output, `${name}.png`);
	await page.screenshot({ path, animations: 'disabled', scale: 'css' });
	const png = await readFile(path);
	assert.equal(png.readUInt32BE(16), size.width);
	assert.equal(png.readUInt32BE(20), size.height);
	screenshots.push({ name, ...size });
	console.log(`Captured ${name}.png (${size.width} × ${size.height})`);
}

try {
	await mkdir(output, { recursive: true });
	await mkdir(resolve('test-results'), { recursive: true });
	const fixture = await fixtures();
	instance = await electron.launch({
		executablePath: require('electron'),
		args: [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: join(root, 'AppData') },
	});
	page = await instance.firstWindow();
	page.setDefaultTimeout(15000);
	page.on('pageerror', (error) => errors.push(error.message));
	await instance.evaluate(({ app, BrowserWindow }, size) => {
		BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height);
		app.focus({ steal: true });
	}, size);
	await page.bringToFront();
	// Keep the capture viewport consistent even when macOS limits the native window to the display height.
	await page.setViewportSize(size);
	await page.waitForSelector('.welcome, .project-header');
	await call('credential', { rootUrl: fixture.base, username: 'demo', password: 'temporary-demo-only' });
	for (const copy of fixture.copies) {
		await call('addWorkingCopy', { path: copy.path, name: copy.name });
	}
	await call('manage', { entity: 'group', name: '产品开发' });
	const state = await call('manage', { entity: 'group', name: '共享资源' });
	for (const repo of state.repositories) {
		const name = repo.rootUrl.endsWith('/atlas-desktop') ? 'Atlas Studio' : repo.rootUrl.endsWith('/interface-kit') ? 'Interface Kit' : 'Documentation';
		const groupId = state.groups.find((group) => group.name === (name === 'Atlas Studio' ? '产品开发' : '共享资源')).id;
		await call('manage', { entity: 'repository', id: repo.id, name, groupId });
		if (name === 'Atlas Studio') {
			for (const [path, name] of [
				['trunk', '主线 · trunk'],
				['branches', '发布与功能分支'],
				['tags', '版本标签'],
			]) {
				await call('bookmark', { repositoryId: repo.id, url: `${repo.rootUrl}/${path}`, name });
			}
		}
	}
	const copy = state.workingCopies.find((copy) => copy.path === fixture.copies[0].path);
	for (const item of state.workingCopies) {
		await call('status', { wcId: item.id });
	}
	await call('manage', { entity: 'workingCopy', id: copy.id, favorite: true });
	await call('activate', { wcId: copy.id });
	await call('session', {
		wcId: copy.id,
		patch: {
			view: 'changes',
			currentPath: selectedPath,
			expanded: ['.', 'src', 'src/components', 'src/lib', 'src/styles', 'docs', 'assets'],
			treeInitialized: true,
			selected: [selectedPath, 'src/components/CommitPanel.tsx', 'src/lib/session.ts'],
			draft: '完善项目导航与提交审阅\n\n• 为工作副本加入收藏和变更数量\n• 保留项目会话与提交草稿\n• 改善键盘操作与选中状态',
		},
	});
	await call('settings', { theme: 'ocean' });
	await page.reload();
	await page.waitForSelector('.diff-view .diff-line');
	await resize('调整导航宽度', 58, 0);
	await resize('调整详情宽度', -44, 0);
	await resize('调整文件与差异高度', 0, 280);
	await page.getByRole('button', { name: '并排', exact: true }).click();
	await page.waitForSelector('.diff-line.split');
	await page.locator('.file-pane > .virtual-list').evaluate((element) => {
		element.scrollTop = 0;
	});
	await page.waitForFunction(() => {
		const viewport = document.querySelector('.file-pane > .virtual-list')?.getBoundingClientRect();
		const lastRow = document.querySelector('.file-row[data-path="src/styles/tokens.css"]')?.getBoundingClientRect();
		return viewport && lastRow && lastRow.bottom <= viewport.bottom;
	});
	await screenshot('workspace');
	await theme('dark', '灰色');
	await page.getByRole('tab', { name: '历史', exact: true }).click();
	await page.waitForSelector('.history-day');
	await page.getByRole('button', { name: `查看 r${fixture.latest} 本次差异`, exact: true }).click();
	await page.waitForSelector('.history-inline-diff .diff-line');
	await screenshot('history');
	await page.getByRole('button', { name: '收起差异预览', exact: true }).click();
	await page.getByRole('tab', { name: '文件', exact: true }).click();
	await page.waitForSelector('.diff-view .diff-line');
	await theme('ocean', '深蓝');
	await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'commit'));
	await page.getByRole('dialog', { name: `提交到 ${copy.name}`, exact: true }).waitFor();
	await page.waitForSelector('.commit-modal .commit-file');
	await screenshot('commit');
	await page.getByRole('button', { name: '稍后继续', exact: true }).click();
	await page.getByRole('button', { name: '浏览仓库 Atlas Studio', exact: true }).click();
	await page.locator('.remote-entry').first().waitFor();
	await page.getByRole('textbox', { name: '仓库 URL', exact: true }).fill(`${fixture.base}/atlas-desktop/trunk`);
	await page.getByRole('button', { name: '浏览', exact: true }).click();
	await page.locator('.remote-entry').filter({ hasText: 'src' }).waitFor();
	await screenshot('repositories');
	await page
		.getByRole('button', { name: /^Atlas Desktop .*本地工作副本$/ })
		.first()
		.click();
	await page.waitForSelector('.diff-view .diff-line');
	await settings();
	await page.locator('.settings-themes > button').last().waitFor();
	await screenshot('appearance');
	assert.deepEqual(errors, []);
	await writeFile(
		resolve('test-results/readme-screenshots.json'),
		JSON.stringify({ screenshots, rendererErrors: errors, fixture: 'Isolated local SVN repositories; fictional project data.' }, null, 2),
	);
} catch (error) {
	await page?.screenshot({ path: resolve('test-results/readme-screenshot-failure.png'), animations: 'disabled', scale: 'css' }).catch(() => {});
	throw error;
} finally {
	await instance?.close().catch(() => {});
	if (server && server.exitCode === null) {
		server.kill('SIGTERM');
		await new Promise((resolve) => server.once('exit', resolve));
	}
	await rm(root, { recursive: true, force: true });
}
