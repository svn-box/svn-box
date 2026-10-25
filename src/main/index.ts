import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage, Menu, nativeTheme } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schemas, requestOptionsSchema } from '../shared/validation';
import type { RpcName, RpcMap, Reply, AppError } from '../shared/types';
import { SvnService, type Vault } from './service';
import { Store } from './store';
import { Runner, SvnError } from './runner';

const currentDirectory = __dirname;
if (process.env.SVNBOX_DATA_DIR) {
	app.setPath('userData', process.env.SVNBOX_DATA_DIR);
}
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) {
	app.quit();
}
const runner = new Runner(app.isPackaged ? join(process.resourcesPath, 'svn/bin/svn') : join(currentDirectory, `../../resources/svn/darwin-${process.arch}/bin/svn`));
let window: BrowserWindow | null = null;
let service: SvnService;
let quitting = false;
let exitApproved = false;

class SecureVault implements Vault {
	private directory: string;
	private queue = Promise.resolve();

	constructor(directory: string) {
		this.directory = directory;
	}

	async get(id: string): Promise<string | undefined> {
		const data = await this.load();
		if (!data[id]) {
			return undefined;
		}
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error('macOS 安全存储当前不可用');
		}
		return safeStorage.decryptString(Buffer.from(data[id], 'base64'));
	}

	async set(id: string, password: string): Promise<void> {
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error('macOS 安全存储不可用，密码未保存');
		}
		const encrypted = safeStorage.encryptString(password).toString('base64');
		await this.change((data) => {
			data[id] = encrypted;
		});
	}

	async delete(id: string): Promise<void> {
		await this.change((data) => {
			delete data[id];
		});
	}

	private async load(): Promise<Record<string, string>> {
		try {
			return JSON.parse(await readFile(join(this.directory, 'credentials.enc.json'), 'utf8'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return {};
			}
			throw error;
		}
	}

	private async change(callback: (data: Record<string, string>) => void): Promise<void> {
		const task = this.queue
			.catch(() => {})
			.then(async () => {
				const data = await this.load();
				callback(data);
				const target = join(this.directory, 'credentials.enc.json');
				await writeFile(`${target}.tmp`, JSON.stringify(data), { mode: 0o600 });
				await rename(`${target}.tmp`, target);
			});
		this.queue = task;
		await task;
	}
}

function navigate(action: string): void {
	window?.webContents.send('svnbox:navigate', action);
}

async function system(input: RpcMap['system']['input']): Promise<void> {
	const target = await service.systemPath(input.wcId, input.path);
	if (input.action === 'copy') {
		clipboard.writeText(target);
		return;
	}
	if (input.action === 'reveal') {
		shell.showItemInFolder(target);
		return;
	}
	const info = await lstat(target);
	if (info.isSymbolicLink() && input.action === 'merge') {
		throw new SvnError({ kind: 'validation', message: '符号链接请在终端中核实目标后处理' });
	}
	const folder = info.isDirectory() ? target : dirname(target);
	if (input.action === 'terminal') {
		await runExternal('/usr/bin/open', ['-a', 'Terminal', folder]);
		return;
	}
	const tool = service.store.get().settings.mergeTool;
	if (!tool || !isAbsolute(tool)) {
		throw new SvnError({ kind: 'validation', message: '请先在设置中指定外部合并工具的 .app 或可执行文件绝对路径' });
	}
	if (extname(tool).toLowerCase() === '.app') {
		await runExternal('/usr/bin/open', ['-a', tool, target]);
	} else {
		await runExternal(tool, [target], true);
	}
}

async function runExternal(executable: string, args: string[], detached = false): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, args, { shell: false, stdio: 'ignore', detached });
		child.on('error', reject);
		if (detached) {
			child.once('spawn', () => {
				child.unref();
				resolve();
			});
		} else {
			child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`外部程序退出码 ${code}`))));
		}
	});
}

function registerIpc(): void {
	ipcMain.handle('svnbox:call', async (event, method: RpcName, input: unknown, options: unknown): Promise<Reply<unknown>> => {
		try {
			const expectedUrl = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(currentDirectory, '../renderer/index.html')).href;
			if (
				!window ||
				event.sender !== window.webContents ||
				event.senderFrame !== window.webContents.mainFrame ||
				(event.senderFrame.url.split('#')[0] !== expectedUrl.replace(/\/$/, '') && event.senderFrame.url.split('#')[0] !== `${expectedUrl.replace(/\/$/, '')}/`)
			) {
				throw new Error('IPC 来源校验失败');
			}
			if (!Object.hasOwn(schemas, method)) {
				throw new Error('不支持的操作');
			}
			const data: any = schemas[method].parse(input);
			const request = requestOptionsSchema.parse(options ?? {});
			const value = await service.withRequest(request.requestId, method, async () => {
				let value: unknown;
				switch (method) {
					case 'state':
						value = service.store.get();
						break;
					case 'detect':
						value = await service.detect(data.path);
						break;
					case 'settings':
						value = await service.settings(data);
						nativeTheme.themeSource = service.store.get().settings.theme;
						break;
					case 'pickFolder': {
						const selected = await dialog.showOpenDialog(window!, { title: '选择文件夹', properties: ['openDirectory', 'createDirectory'] });
						value = selected.canceled ? null : selected.filePaths[0];
						break;
					}
					case 'addWorkingCopy':
						value = await service.addWorkingCopy(data.path, data.name);
						break;
					case 'addRepository':
						value = await service.addRepository(data.url, data.name, data.credentialId);
						break;
					case 'bookmark':
						value = await service.bookmark(data);
						break;
					case 'compare': {
						const tool = await new Promise<string>((resolve, reject) => {
							execFile('/usr/bin/xcrun', ['--find', 'opendiff'], (error, stdout) => {
								if (error) {
									reject(new SvnError({ kind: 'path', message: '未找到 FileMerge，请安装 Xcode 并选择开发者工具路径' }));
								} else {
									resolve(stdout.trim());
								}
							});
						});
						const comparison = await service.comparison(data.wcId, data.path, data.revision);
						await runExternal(tool, [comparison.left, comparison.right], true);
						break;
					}
					case 'manage':
						value = await service.manage(data);
						break;
					case 'session':
						value = await service.saveSession(data.wcId, data.patch);
						break;
					case 'activate':
						await service.store.change((state) => {
							if (!state.workingCopies.some((copy) => copy.id === data.wcId)) {
								throw new Error('工作副本不存在');
							}
							state.activeId = data.wcId;
						});
						break;
					case 'status':
						value = await service.status(data.wcId, data.remote);
						break;
					case 'info':
						value = await service.info(data.wcId, data.path);
						break;
					case 'properties':
						value = await service.properties(data.wcId, data.path);
						break;
					case 'diff':
						value = await service.diff(data.wcId, data.path, data.revision);
						break;
					case 'log':
						value = await service.log(data.wcId, data.path, data.before);
						break;
					case 'list':
						value = await service.list(data.url, data.repositoryId);
						break;
					case 'checkout':
						value = await service.checkout(data);
						break;
					case 'review':
						value = await service.review(data);
						break;
					case 'execute':
						value = await service.execute(data.reviewId);
						break;
					case 'operations':
						value = service.getOperations();
						break;
					case 'cancel':
						service.cancel(data.id);
						break;
					case 'cancelRequest':
						service.cancelRequest(data.id);
						break;
					case 'credential':
						value = await service.credential(data);
						break;
					case 'authentication':
						value = service.authentication(data);
						break;
					case 'system':
						await system(data);
						break;
				}
				return value;
			});
			return { ok: true, value };
		} catch (error) {
			const info: AppError = error instanceof SvnError ? error.info : { kind: 'validation', message: error instanceof Error ? error.message : String(error) };
			return { ok: false, error: info };
		}
	});
}

async function createWindow(): Promise<void> {
	window = new BrowserWindow({
		width: 1440,
		height: 940,
		minWidth: 1000,
		minHeight: 680,
		title: '仓盒 · svnbox',
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: { x: 19, y: 22 },
		backgroundColor: nativeTheme.shouldUseDarkColors ? '#17191c' : '#f8f9fb',
		webPreferences: { preload: join(currentDirectory, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', (event) => event.preventDefault());
	window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	window.on('close', (event) => {
		if (quitting) {
			return;
		}
		if (service.getOperations().some((operation) => ['running', 'waiting'].includes(operation.state))) {
			const choice = dialog.showMessageBoxSync(window!, {
				type: 'warning',
				title: '仍有 SVN 操作进行中',
				message: '退出会终止进行中的操作。取消不会回滚，提交结果可能需要核实。',
				buttons: ['继续等待', '退出并终止'],
				defaultId: 0,
				cancelId: 0,
			});
			if (choice === 0) {
				event.preventDefault();
			} else {
				exitApproved = true;
			}
		}
	});
	if (process.env.ELECTRON_RENDERER_URL) {
		await window.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		await window.loadFile(join(currentDirectory, '../renderer/index.html'));
	}
	window.on('closed', () => {
		window = null;
	});
}

app.on('second-instance', () => {
	if (window?.isMinimized()) {
		window.restore();
	}
	window?.focus();
});

app.whenReady().then(async () => {
	if (!ownsInstance) {
		return;
	}
	app.setAboutPanelOptions({ applicationName: '仓盒 svnbox', applicationVersion: '0.1.0', copyright: '© 2026 svnbox' });
	const directory = app.getPath('userData');
	service = new SvnService(new Store(directory), runner, (operation) => window?.webContents.send('svnbox:operation', operation), new SecureVault(directory));
	try {
		await service.initialize();
	} catch (error) {
		dialog.showErrorBox('无法读取仓盒数据', String(error));
		app.quit();
		return;
	}
	nativeTheme.themeSource = service.store.get().settings.theme;
	registerIpc();
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: '仓盒',
				submenu: [
					{ role: 'about', label: '关于仓盒' },
					{ type: 'separator' },
					{ label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => navigate('settings') },
					{ type: 'separator' },
					{ role: 'hide', label: '隐藏仓盒' },
					{ role: 'hideOthers', label: '隐藏其他' },
					{ role: 'unhide', label: '全部显示' },
					{ type: 'separator' },
					{ role: 'quit', label: '退出仓盒' },
				],
			},
			{
				label: '文件',
				submenu: [
					{ label: '添加工作副本…', accelerator: 'CmdOrCtrl+O', click: () => navigate('add') },
					{ label: '浏览与检出…', accelerator: 'CmdOrCtrl+Shift+O', click: () => navigate('remote') },
					{ type: 'separator' },
					{ label: '提交…', accelerator: 'CmdOrCtrl+Enter', click: () => navigate('commit') },
					{ label: '更新…', accelerator: 'CmdOrCtrl+U', click: () => navigate('update') },
					{ label: '刷新本地状态', accelerator: 'CmdOrCtrl+R', click: () => navigate('refresh') },
					{ type: 'separator' },
					{ role: 'close', label: '关闭窗口' },
				],
			},
			{
				label: '编辑',
				submenu: [
					{ role: 'undo', label: '撤销' },
					{ role: 'redo', label: '重做' },
					{ type: 'separator' },
					{ role: 'cut', label: '剪切' },
					{ role: 'copy', label: '复制' },
					{ role: 'paste', label: '粘贴' },
					{ role: 'selectAll', label: '全选' },
				],
			},
			{
				label: '视图',
				submenu: [
					{ label: '变更', accelerator: 'CmdOrCtrl+1', click: () => navigate('changes') },
					{ label: '文件', accelerator: 'CmdOrCtrl+2', click: () => navigate('files') },
					{ label: '历史', accelerator: 'CmdOrCtrl+3', click: () => navigate('history') },
					{ label: '操作记录', accelerator: 'CmdOrCtrl+J', click: () => navigate('operations') },
					{ type: 'separator' },
					{ role: 'toggleDevTools', label: '开发者工具' },
					{ role: 'togglefullscreen', label: '全屏' },
				],
			},
			{
				label: '窗口',
				submenu: [
					{ role: 'minimize', label: '最小化' },
					{ role: 'zoom', label: '缩放' },
				],
			},
		]),
	);
	await createWindow();
	app.on('activate', () => {
		if (!window) {
			void createWindow();
		}
	});
});
app.on('before-quit', (event) => {
	if (quitting) {
		return;
	}
	event.preventDefault();
	if (!exitApproved && service?.getOperations().some((operation) => ['running', 'waiting'].includes(operation.state))) {
		const choice = dialog.showMessageBoxSync({
			type: 'warning',
			title: '仍有操作进行中',
			message: '退出会终止 SVN 操作。取消不会回滚，提交结果可能需要核实。',
			buttons: ['继续等待', '退出并终止'],
			defaultId: 0,
			cancelId: 0,
		});
		if (choice === 0) {
			return;
		}
	}
	quitting = true;
	runner.shutdown();
	void Promise.all([service?.store.flush(), service?.flush()]).finally(() => app.quit());
});
app.on('will-quit', () => {
	runner.shutdown();
	void service?.flush();
});
app.on('window-all-closed', () => {
	app.quit();
});
