import { translate, uiI18n, UI_LANGUAGE } from '../shared/i18n';
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage, Menu, nativeTheme, autoUpdater as nativeAutoUpdater } from 'electron';
import electronUpdater from 'electron-updater';
import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schemas, requestOptionsSchema } from '../shared/validation';
import type { RpcName, RpcMap, Reply, AppError } from '../shared/types';
import { getTheme } from '../shared/themes';
import { operationOutput, operationLabels, operationLabel } from '../shared/operation-log';
import { appReleasesUrl } from '../shared/app-updates';
import { AppUpdates } from './app-updates';
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
let appUpdates: AppUpdates;
let installingUpdate = false;
let pendingSvnWrites = 0;

async function startSvnWrite<T>(work: () => Promise<T>): Promise<T> {
	pendingSvnWrites++;
	try {
		return await work();
	} finally {
		pendingSvnWrites--;
	}
}

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
			throw new Error(translate('desktop.macosSecureStorageIsUnavailable'));
		}
		return safeStorage.decryptString(Buffer.from(data[id], 'base64'));
	}

	async set(id: string, password: string): Promise<void> {
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error(translate('desktop.macosSecureStorageIsUnavailableThePasswordWas'));
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
		throw new SvnError({
			kind: 'validation',
			message: translate('desktop.verifyTheSymbolicLinkTargetInTerminalBefore'),
		});
	}
	const folder = info.isDirectory() ? target : dirname(target);
	if (input.action === 'terminal') {
		await runExternal('/usr/bin/open', ['-a', 'Terminal', folder]);
		return;
	}
	const tool = service.store.get().settings.mergeTool;
	if (!tool || !isAbsolute(tool)) {
		throw new SvnError({
			kind: 'validation',
			message: translate('desktop.setAnAbsolutePathToYourExternalMerge'),
		});
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
			child.on('close', (code) =>
				code === 0
					? resolve()
					: reject(
							new Error(
								translate('desktop.externalToolExitedWithCode', {
									code: code,
								}),
							),
						),
			);
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
				throw new Error(translate('desktop.ipcOriginValidationFailed'));
			}
			if (!Object.hasOwn(schemas, method)) {
				throw new Error(translate('desktop.unsupportedOperation'));
			}
			const data: any = schemas[method].parse(input);
			if (installingUpdate && method !== 'appUpdate') {
				throw new Error(translate('desktop.theAppIsPreparingToRestartPleaseWait'));
			}
			const request = requestOptionsSchema.parse(options ?? {});
			const value = await service.withRequest(request.requestId, method, async () => {
				let value: unknown;
				switch (method) {
					case 'appUpdate':
						if (data.action === 'release') {
							const version = appUpdates.getState().version;
							await shell.openExternal(version ? `${appReleasesUrl}/tag/v${version}` : `${appReleasesUrl}/latest`);
							value = appUpdates.getState();
						} else {
							value = await appUpdates.act(data.action);
						}
						break;
					case 'state':
						value = service.store.get();
						break;
					case 'detect':
						value = await service.detect(data.path);
						break;
					case 'settings':
						value = await service.settings(data);
						if (data.language) {
							await uiI18n.changeLanguage(data.language);
							refreshApplicationMenu();
							window?.webContents.send('svnbox:language', data.language);
						}
						nativeTheme.themeSource = getTheme(service.store.get().settings.theme).scheme;
						break;
					case 'pickFolder': {
						const selected = await dialog.showOpenDialog(window!, {
							title: translate('desktop.chooseAFolder'),
							properties: ['openDirectory', 'createDirectory'],
						});
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
									reject(
										new SvnError({
											kind: 'path',
											message: translate('desktop.filemergeWasNotFoundInstallXcodeAndSelect'),
										}),
									);
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
								throw new Error(translate('desktop.workingCopyNotFound'));
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
						value = await startSvnWrite(() => service.checkout(data));
						break;
					case 'review':
						value = await service.review(data);
						break;
					case 'execute':
						value = await startSvnWrite(() => service.execute(data.reviewId));
						break;
					case 'operations':
						value = service.getOperations();
						break;
					case 'copyOperation': {
						const operation = service.getOperations().find((entry) => entry.id === data.id);
						if (!operation) {
							throw new SvnError({
								kind: 'stale',
								message: translate('desktop.thisLogWasRemovedSelectAnotherRecord'),
							});
						}
						const project = service.store.get().workingCopies.find((copy) => copy.id === operation.wcId)?.name ?? translate('common.remoteRepository');
						clipboard.writeText(
							[
								operationLabel(operation),
								project,
								operationLabels[operation.state],
								operation.startedAt,
								operation.endedAt,
								operation.error?.message,
								operationOutput(operation),
							]
								.filter(Boolean)
								.join('\n'),
						);
						break;
					}
					case 'clearOperations':
						value = await service.clearOperations(data);
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
					case 'credentialForEdit':
						value = await service.credentialForEdit(data);
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
		title: translate('desktop.windowTitle'),
		titleBarStyle: 'hiddenInset',
		trafficLightPosition: { x: 19, y: 26 },
		backgroundColor: '#00000000',
		vibrancy: 'sidebar',
		visualEffectState: 'followWindow',
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
				title: translate('desktop.anSvnOperationIsStillRunning'),
				message: translate('desktop.quittingWillStopRunningOperationsCancellationDoesNot'),
				buttons: [translate('desktop.keepWaiting'), translate('desktop.quitAndStopOperations')],
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

function refreshApplicationMenu(): void {
	app.setAboutPanelOptions({ applicationName: translate('desktop.aboutApplicationName'), applicationVersion: app.getVersion(), copyright: '© 2026 svnbox' });
	window?.setTitle(translate('desktop.windowTitle'));
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: translate('common.appName'),
				submenu: [
					{
						role: 'about',
						label: translate('desktop.aboutSvnbox'),
					},
					{
						label: translate('desktop.checkForUpdates'),
						click: () => navigate('app-update'),
					},
					{ type: 'separator' },
					{
						label: translate('desktop.settings'),
						accelerator: 'CmdOrCtrl+,',
						click: () => navigate('settings'),
					},
					{ type: 'separator' },
					{
						role: 'hide',
						label: translate('desktop.hideSvnbox'),
					},
					{
						role: 'hideOthers',
						label: translate('desktop.hideOthers'),
					},
					{
						role: 'unhide',
						label: translate('desktop.showAll'),
					},
					{ type: 'separator' },
					{
						role: 'quit',
						label: translate('desktop.quitSvnbox'),
					},
				],
			},
			{
				label: translate('common.file'),
				submenu: [
					{
						label: translate('desktop.addWorkingCopy'),
						accelerator: 'CmdOrCtrl+O',
						click: () => navigate('add'),
					},
					{
						label: translate('desktop.browseAndCheckOut'),
						accelerator: 'CmdOrCtrl+Shift+O',
						click: () => navigate('remote'),
					},
					{ type: 'separator' },
					{
						label: translate('desktop.commit'),
						accelerator: 'CmdOrCtrl+Enter',
						click: () => navigate('commit'),
					},
					{
						label: translate('desktop.update'),
						accelerator: 'CmdOrCtrl+U',
						click: () => navigate('update'),
					},
					{
						label: translate('common.refreshLocalStatus'),
						accelerator: 'CmdOrCtrl+R',
						click: () => navigate('refresh'),
					},
					{ type: 'separator' },
					{
						role: 'close',
						label: translate('desktop.closeWindow'),
					},
				],
			},
			{
				label: translate('desktop.edit'),
				submenu: [
					{
						role: 'undo',
						label: translate('desktop.undo'),
					},
					{
						role: 'redo',
						label: translate('desktop.redo'),
					},
					{ type: 'separator' },
					{
						role: 'cut',
						label: translate('desktop.cut'),
					},
					{
						role: 'copy',
						label: translate('common.copy'),
					},
					{
						role: 'paste',
						label: translate('desktop.paste'),
					},
					{
						role: 'selectAll',
						label: translate('desktop.selectAll'),
					},
				],
			},
			{
				label: translate('desktop.view'),
				submenu: [
					{
						label: translate('desktop.changes'),
						accelerator: 'CmdOrCtrl+1',
						click: () => navigate('changes'),
					},
					{
						label: translate('common.files'),
						accelerator: 'CmdOrCtrl+2',
						click: () => navigate('files'),
					},
					{
						label: translate('desktop.history'),
						accelerator: 'CmdOrCtrl+3',
						click: () => navigate('history'),
					},
					{
						label: translate('desktop.operations'),
						accelerator: 'CmdOrCtrl+J',
						click: () => navigate('operations'),
					},
					{ type: 'separator' },
					{
						role: 'toggleDevTools',
						label: translate('desktop.developerTools'),
					},
					{
						role: 'togglefullscreen',
						label: translate('desktop.fullScreen'),
					},
				],
			},
			{
				label: translate('desktop.window'),
				submenu: [
					{
						role: 'minimize',
						label: translate('desktop.minimize'),
					},
					{
						role: 'zoom',
						label: translate('desktop.zoom'),
					},
				],
			},
		]),
	);
}

app.whenReady().then(async () => {
	if (!ownsInstance) {
		return;
	}
	const directory = app.getPath('userData');
	service = new SvnService(new Store(directory), runner, (operation) => window?.webContents.send('svnbox:operation', operation), new SecureVault(directory));
	try {
		await service.initialize();
	} catch (error) {
		dialog.showErrorBox(translate('desktop.unableToReadSvnboxData'), String(error));
		app.quit();
		return;
	}
	await uiI18n.changeLanguage(service.store.get().settings.language ?? UI_LANGUAGE);
	nativeTheme.themeSource = getTheme(service.store.get().settings.theme).scheme;
	const updater = electronUpdater.autoUpdater;
	updater.autoDownload = false;
	updater.autoInstallOnAppQuit = false;
	updater.allowDowngrade = false;
	updater.allowPrerelease = false;
	updater.disableDifferentialDownload = true;
	updater.logger = null;
	appUpdates = new AppUpdates({
		client: updater,
		version: app.getVersion(),
		disabledReason: !app.isPackaged
			? translate('updates.developmentDisabled')
			: process.platform !== 'darwin' || process.arch !== 'arm64'
				? translate('updates.platformDisabled')
				: undefined,
		disabledReasonKey: !app.isPackaged ? 'updates.developmentDisabled' : process.platform !== 'darwin' || process.arch !== 'arm64' ? 'updates.platformDisabled' : undefined,
		isBusy: () => pendingSvnWrites > 0 || service.getOperations().some((operation) => ['waiting', 'running'].includes(operation.state)),
		beforeInstall: async () => {
			await Promise.all([service.store.flush(), service.flush()]);
		},
		onChange: (state) => {
			installingUpdate = state.phase === 'installing';
			window?.webContents.send('svnbox:app-update', state);
		},
	});
	nativeAutoUpdater.on('before-quit-for-update', () => {
		if (installingUpdate) {
			quitting = true;
			runner.shutdown();
		}
	});
	registerIpc();
	refreshApplicationMenu();
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
			title: translate('desktop.anOperationIsStillRunning'),
			message: translate('desktop.quittingWillStopSvnOperationsCancellationDoesNot'),
			buttons: [translate('desktop.keepWaiting'), translate('desktop.quitAndStopOperations')],
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
