import { _electron as electron } from 'playwright';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, realpath, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-auth-ui-')));
const data = join(root, 'app-data');
const secret = 'temporary-auth-ui-123';
const servers = [];
const forwarders = [];
const forwardedSockets = new Set();
let desktop;
const errors = [];
const testSvn = process.env.SVNBOX_TEST_LAZY_FORWARDER
	? process.env.SVNBOX_PACKAGED_APP
		? resolve(dirname(process.env.SVNBOX_PACKAGED_APP), '../Resources/svn/bin/svn')
		: resolve(`resources/svn/darwin-${process.arch}/bin/svn`)
	: '/opt/homebrew/bin/svn';

async function lazyForward(port) {
	const server = createServer((client) => {
		forwardedSockets.add(client);
		client.on('error', () => {});
		client.on('close', () => forwardedSockets.delete(client));
		client.once('data', (first) => {
			const upstream = connect(port, '127.0.0.1');
			forwardedSockets.add(upstream);
			upstream.on('error', () => client.destroy());
			upstream.on('close', () => {
				forwardedSockets.delete(upstream);
				client.destroy();
			});
			client.on('close', () => upstream.destroy());
			upstream.write(first);
			client.pipe(upstream);
			upstream.pipe(client);
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	forwarders.push(server);
	return server.address().port;
}

async function serve() {
	const port = await new Promise((resolve) => {
		const socket = createServer();
		socket.listen(0, '127.0.0.1', () => {
			const address = socket.address();
			socket.close(() => resolve(address.port));
		});
	});
	const child = spawn('/opt/homebrew/bin/svnserve', ['--daemon', '--foreground', '--listen-host', '127.0.0.1', '--listen-port', String(port), '--root', root], {
		stdio: 'ignore',
	});
	servers.push(child);
	for (let attempt = 0; attempt < 60; attempt++) {
		if (
			await new Promise((resolve) => {
				const socket = connect(port, '127.0.0.1');
				socket.once('connect', () => {
					socket.destroy();
					resolve(true);
				});
				socket.once('error', () => resolve(false));
			})
		) {
			return `svn://127.0.0.1:${process.env.SVNBOX_TEST_LAZY_FORWARDER ? await lazyForward(port) : port}`;
		}
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error('临时认证服务器启动失败');
}

async function launch() {
	const instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: data },
	});
	const page = await instance.firstWindow();
	await instance.evaluate(({ app }) => app.focus({ steal: true }));
	await page.bringToFront();
	page.on('pageerror', (error) => errors.push(error.message));
	await page.waitForSelector('.welcome, .project-header');
	return { instance, page };
}

async function call(method, input) {
	return desktop.page.evaluate(async ({ method, input }) => window.svnbox.call(method, input), { method, input });
}

async function waitUntil(predicate) {
	const deadline = Date.now() + 30000;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('真实认证状态未在 30 秒内完成');
}

async function openRepository(url, name) {
	const page = desktop.page;
	await page.getByRole('button', { name: '添加项目', exact: true }).click();
	await page.getByRole('menuitem', { name: '添加远端仓库…', exact: true }).click();
	await page.getByLabel('仓库 URL', { exact: true }).fill(url);
	await page.getByPlaceholder('书签名称（可选）', { exact: true }).fill(name);
	await page.getByRole('button', { name: '验证并保存书签', exact: true }).click();
}

async function closeRemote() {
	await desktop.page.getByRole('dialog', { name: '仓库浏览与检出', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
}

async function openConnectionEditor() {
	await desktop.page.getByRole('button', { name: '浏览仓库 认证仓库一', exact: true }).click({ button: 'right' });
	await desktop.page.getByRole('menuitem', { name: '此连接的认证…', exact: true }).click();
	const editor = desktop.page.getByRole('dialog', { name: '连接认证', exact: true });
	await editor.waitFor();
	await desktop.page.waitForFunction((input) => !input.disabled, await editor.getByLabel('密码', { exact: true }).elementHandle());
	return editor;
}

try {
	for (const name of ['one', 'two', 'three']) {
		const repository = join(root, name);
		execFileSync('/opt/homebrew/bin/svnadmin', ['create', repository]);
		execFileSync('/opt/homebrew/bin/svn', ['mkdir', `${pathToFileURL(repository).href}/trunk`, '-m', '认证测试初始版本']);
		await writeFile(join(repository, 'conf/svnserve.conf'), '[general]\nanon-access = none\nauth-access = write\npassword-db = passwd\nrealm = svnbox-auth-ui\n');
		await writeFile(join(repository, 'conf/passwd'), `[users]\nshared = ${secret}\n`);
	}
	const base = await serve();
	const other = await serve();
	const workingCopy = join(root, 'network-copy');
	await new Promise((resolve, reject) => {
		const child = execFile(
			testSvn,
			['checkout', '--non-interactive', '--no-auth-cache', '--username', 'shared', '--password-from-stdin', `${base}/one/trunk`, workingCopy],
			{ timeout: 10000, killSignal: 'SIGKILL' },
			(error) => (error ? reject(error) : resolve()),
		);
		child.stdin.end(`${secret}\n`);
	});
	desktop = await launch();
	const page = desktop.page;
	await mkdir(resolve('test-results'), { recursive: true });
	assert.equal(await page.locator('.sidebar-footer').count(), 0);
	await page.getByRole('button', { name: '设置', exact: false }).first().click();
	const settings = page.getByRole('dialog', { name: '设置', exact: true });
	await settings.waitFor();
	assert.equal(await settings.locator('input[type=password]').count(), 0);
	assert.equal(await page.getByText('认证配置', { exact: true }).count(), 0);
	await page.screenshot({ path: resolve('test-results/settings-no-global-auth.png') });
	await settings.getByRole('button', { name: '关闭', exact: true }).first().click();
	await openRepository(`${base.replace('svn://', 'svn://shared@')}/one/trunk`, '认证仓库一');
	const login = page.getByRole('dialog', { name: '连接认证', exact: true });
	await login.waitFor();
	assert.equal(await login.getByLabel('用户名', { exact: true }).inputValue(), 'shared');
	assert.equal(await login.getByLabel('密码', { exact: true }).inputValue(), '', '不得回填已保存的密码');
	assert.equal(await login.getByLabel('密码', { exact: true }).evaluate((input) => input === document.activeElement), true, '用户名已知时聚焦密码');

	await login.getByLabel('密码', { exact: true }).fill(secret);
	await login.screenshot({ path: resolve('test-results/authentication-c-light.png') });
	await login.getByRole('button', { name: '取消', exact: true }).click();
	await login.waitFor({ state: 'hidden' });
	assert.equal((await call('state')).credentials.length, 0, '取消首次认证不保存密码');
	await closeRemote();
	await page.getByRole('button', { name: /^设置/ }).click();
	await settings.getByRole('button', { name: '灰色', exact: true }).click();
	await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
	await settings.getByRole('button', { name: '关闭', exact: true }).first().click();
	await openRepository(`${base.replace('svn://', 'svn://shared@')}/one/trunk`, '认证仓库一');
	await login.waitFor();
	await login.getByLabel('密码', { exact: true }).fill(secret);
	await login.screenshot({ path: resolve('test-results/authentication-c-dark.png') });
	await page.emulateMedia({ colorScheme: 'light' });
	assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true, '系统外观不覆盖已选主题');
	await login.locator('.authentication-options > summary').click();
	await login.getByRole('combobox', { name: '认证适用范围', exact: true }).click();
	assert.equal(await page.getByRole('listbox').locator('input').count(), 0, '两个范围选项不需要搜索框');
	assert.equal(await page.getByRole('option').count(), 2);
	await page.getByRole('listbox').screenshot({ path: resolve('test-results/authentication-c-range.png') });
	await page.keyboard.press('End');
	await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].at(-1) === document.activeElement);
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => document.querySelector('.authentication-options .select-trigger')?.textContent?.includes('仅当前仓库路径'));
	assert.equal(await login.locator('.authentication-root').count(), 0);
	assert.equal(await login.locator('.authentication-options > summary small').count(), 0);
	await login.getByRole('combobox', { name: '认证适用范围', exact: true }).click();
	await page.getByRole('option', { name: /此连接的所有子路径/ }).click();
	await login.locator('.authentication-options > summary').click();
	await page.screenshot({ path: resolve('test-results/connection-authentication.png') });
	await login.getByLabel('密码', { exact: true }).fill('wrong-auth-ui-secret');
	await login.getByRole('button', { name: '保存', exact: true }).click();
	await login.getByRole('alert').waitFor();
	assert.equal(await login.getByLabel('密码', { exact: true }).inputValue(), '', '连接失败后不重新填入被拒绝的密码');
	assert.equal((await call('state')).credentials.length, 1);
	await login.getByLabel('密码', { exact: true }).fill(secret);
	await login.getByRole('button', { name: '保存', exact: true }).click();
	await waitUntil(async () => (await call('state')).repositories.length === 1);
	await page.locator('.authentication-dialog').waitFor({ state: 'hidden' });
	let state = await call('state');
	assert.equal(state.credentials.length, 1);
	assert.equal(state.credentials[0].rootUrl, base);
	assert.ok(!(await readFile(join(data, 'credentials.enc.json'), 'utf8')).includes(secret));
	await closeRemote();
	await openRepository(`${base}/two/trunk`, '认证仓库二');
	await waitUntil(async () => (await call('state')).repositories.length === 2);
	await page.locator('.authentication-dialog').waitFor({ state: 'hidden' });
	assert.equal((await call('state')).credentials.length, 1);
	await closeRemote();
	await openRepository(`${other}/one/trunk`, '另一个连接');
	await login.waitFor();
	await login.getByRole('button', { name: '关闭', exact: true }).click();
	await page.waitForFunction(() => !document.querySelector('.authentication-dialog'));
	assert.equal((await call('state')).repositories.length, 2);
	await closeRemote();
	await desktop.instance.close();
	desktop = await launch();
	await openRepository(`${base}/three/trunk`, '认证仓库三');
	await waitUntil(async () => (await call('state')).repositories.length === 3);
	await desktop.page.locator('.authentication-dialog').waitFor({ state: 'hidden' });
	await closeRemote();
	await desktop.instance.evaluate(({ dialog }, path) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
	}, workingCopy);
	await desktop.instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('svnbox:navigate', 'add'));
	await desktop.page.waitForSelector('.project-header');
	let editor = await openConnectionEditor();
	assert.equal(await editor.getByLabel('密码', { exact: true }).getAttribute('type'), 'password');
	assert.equal(await editor.getByLabel('密码', { exact: true }).inputValue(), secret, '编辑已有认证时载入真实已保存密码');
	await editor.locator('.authentication-options > summary').click();
	await editor.screenshot({ path: resolve('test-results/authentication-edit-saved.png') });
	await editor.getByLabel('用户名', { exact: true }).fill('cancelled-user');
	await editor.getByLabel('密码', { exact: true }).fill('cancelled-password');
	await editor.getByRole('button', { name: '取消', exact: true }).click();
	await editor.waitFor({ state: 'hidden' });
	editor = await openConnectionEditor();
	assert.equal(await editor.getByLabel('用户名', { exact: true }).inputValue(), 'shared');
	assert.equal(await editor.getByLabel('密码', { exact: true }).inputValue(), secret, '取消不能修改已保存密码');
	const editedSecret = 'edited-connection-secret';
	await editor.getByLabel('密码', { exact: true }).fill(editedSecret);
	await editor.getByRole('button', { name: '保存', exact: true }).click();
	await editor.waitFor({ state: 'hidden' });
	editor = await openConnectionEditor();
	assert.equal(await editor.getByLabel('密码', { exact: true }).inputValue(), editedSecret, '保存后重新打开读取修改后的密码');
	assert.ok(!(await readFile(join(data, 'credentials.enc.json'), 'utf8')).includes(editedSecret));
	assert.ok(!JSON.stringify(await call('state')).includes(editedSecret));
	await editor.getByLabel('密码', { exact: true }).fill(secret);
	await editor.getByRole('button', { name: '保存', exact: true }).click();
	await editor.waitFor({ state: 'hidden' });
	await desktop.page.getByRole('button', { name: '浏览仓库 认证仓库一', exact: true }).click({ button: 'right' });
	await desktop.page.getByRole('menuitem', { name: '忘记此连接的认证', exact: true }).click();
	await waitUntil(async () => (await call('state')).credentials.length === 0);
	await desktop.page.locator('.authentication-dialog').waitFor({ state: 'hidden' });
	await desktop.page.getByRole('button', { name: '更新', exact: true }).click();
	let nextLogin = desktop.page.getByRole('dialog', { name: '连接认证', exact: true });
	await nextLogin.waitFor();
	assert.equal(await desktop.page.getByRole('button', { name: '更新', exact: true, includeHidden: true }).isDisabled(), true, '认证期间应继续阻止重复更新');
	await nextLogin.getByLabel('密码', { exact: true }).press('Escape');
	await nextLogin.waitFor({ state: 'hidden' });
	await desktop.page.getByText('操作已取消', { exact: true }).waitFor();
	assert.equal(await desktop.page.getByRole('button', { name: '更新', exact: true }).isEnabled(), true, '取消认证后应恢复更新按钮');
	assert.equal((await call('operations')).length, 0);
	await desktop.page.getByRole('button', { name: '更新', exact: true }).click();
	await nextLogin.waitFor();
	await nextLogin.getByLabel('用户名', { exact: true }).fill('shared');
	await nextLogin.getByLabel('密码', { exact: true }).fill(secret);
	await nextLogin.getByRole('button', { name: '保存', exact: true }).click();
	await waitUntil(async () => (await call('operations')).some((operation) => operation.label === '更新工作副本' && operation.state === 'success'));
	assert.equal((await call('operations')).length, 1);
	assert.equal(errors.length, 0, errors.join('\n'));
	console.log(
		JSON.stringify(
			{
				result: 'passed',
				lazyForwarder: !!process.env.SVNBOX_TEST_LAZY_FORWARDER,
				checks: [
					'已有认证掩码编辑、保存与取消',
					'编辑密码不进入元数据或明文文件',
					'保存/取消按钮及范围冗余文案移除',
					'认证浅深色和无搜索范围 Select',
					'连接登录默认聚焦密码、拒绝后不回填错误密码',
					'全局设置无密码配置',
					'用户名 URL 预填',
					'认证小窗和错误密码',
					'macOS 加密永久保存',
					'不同 UUID 子仓库共用',
					'端口隔离',
					'取消认证',
					'重启复用',
					'连接内忘记认证',
					'取消更新认证不产生写操作',
					'认证后只执行一次更新',
				],
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(error);
	await desktop?.page.screenshot({ path: resolve('test-results/auth-ui-failure.png') }).catch(() => {});
	throw error;
} finally {
	if (desktop) {
		await waitUntil(async () => !(await call('operations')).some((operation) => ['waiting', 'running'].includes(operation.state))).catch(() => {});
	}
	await desktop?.instance.close().catch(() => {});
	for (const socket of forwardedSockets) {
		socket.destroy();
	}
	await Promise.all(forwarders.map((server) => new Promise((resolve) => server.close(resolve))));
	servers.forEach((server) => server.kill());
	await rm(root, { recursive: true, force: true });
}
