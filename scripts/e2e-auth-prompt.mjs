import { _electron as electron } from 'playwright';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-auth-prompt-')));
const sockets = new Set();
let connections = 0;
const stopDurations = [];
const server = createServer((socket) => {
	connections++;
	sockets.add(socket);
	socket.resume();
	socket.on('close', () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `svn://prompt-user@127.0.0.1:${server.address().port}`;
async function waitUntil(predicate, timeout = 3500) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('连接没有及时停止');
}

let instance;
let page;
try {
	instance = await electron.launch({
		executablePath: process.env.SVNBOX_PACKAGED_APP || require('electron'),
		args: process.env.SVNBOX_PACKAGED_APP ? [] : [resolve('out/main/index.js')],
		env: { ...process.env, SVNBOX_DATA_DIR: join(root, 'data') },
	});
	page = await instance.firstWindow();
	await page.waitForSelector('.welcome');
	await page.getByRole('button', { name: '浏览仓库与检出', exact: true }).click();
	await page.getByLabel('仓库 URL', { exact: true }).fill(address);
	await page.getByRole('button', { name: '浏览', exact: true }).click();
	const login = page.getByRole('dialog', { name: '连接认证', exact: true });
	await login.waitFor({ timeout: 1500 });
	assert.equal(connections, 0, '无已保存认证时，必须先弹窗，再发起连接');
	assert.equal(await login.getByLabel('用户名', { exact: true }).inputValue(), 'prompt-user');
	await mkdir(resolve('test-results'), { recursive: true });
	await page.screenshot({ path: resolve('test-results/auth-before-connect.png') });
	await login.getByRole('button', { name: '取消', exact: true }).click();
	await login.waitFor({ state: 'hidden' });
	assert.equal(connections, 0);
	if (process.env.SVNBOX_TEST_AUTH_SAVE) {
		await page.getByRole('button', { name: '浏览', exact: true }).click();
		await login.waitFor({ timeout: 1500 });
		await login.getByLabel('密码', { exact: true }).fill('temporary-prompt-secret');
		await login.getByRole('button', { name: '保存并继续', exact: true }).click();
		await login.waitFor({ state: 'hidden', timeout: 2000 });
		const state = await page.evaluate(() => window.svnbox.call('state'));
		assert.equal(state.credentials.length, 1);
		assert.equal((await readFile(join(root, 'data/credentials.enc.json'), 'utf8')).includes('temporary-prompt-secret'), false);
		await waitUntil(() => sockets.size > 0);
		const authButton = page.getByRole('button', { name: '此连接的认证', exact: true });
		assert.equal(await authButton.isEnabled(), true);
		const firstStop = Date.now();
		await page.getByRole('button', { name: '停止连接', exact: true }).click();
		await page.getByText('连接已停止', { exact: true }).waitFor({ timeout: 500 });
		await waitUntil(() => sockets.size === 0);
		stopDurations.push(Date.now() - firstStop);
		await page.screenshot({ path: resolve('test-results/auth-connect-stopped.png') });
		await page.getByRole('button', { name: '浏览', exact: true }).click();
		await waitUntil(() => sockets.size > 0);
		const editStop = Date.now();
		await authButton.click();
		await login.waitFor({ timeout: 1500 });
		await waitUntil(() => sockets.size === 0);
		stopDurations.push(Date.now() - editStop);
		await login.getByRole('button', { name: '取消', exact: true }).click();
		await login.waitFor({ state: 'hidden' });
		await page.getByRole('button', { name: '浏览', exact: true }).click();
		await waitUntil(() => sockets.size > 0);
		await page.getByRole('dialog', { name: '仓库浏览与检出', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
		await waitUntil(() => sockets.size === 0);
	}
	console.log(
		JSON.stringify(
			{
				result: 'passed',
				stopDurationsMs: stopDurations,
				checks: [
					'服务器不回应时也立即弹出认证',
					'输入用户名预填',
					'连接前可取消',
					'取消未启动 SVN 连接',
					...(process.env.SVNBOX_TEST_AUTH_SAVE
						? ['无响应服务器不阻塞本机保存', '密码密文保存', '停止按钮实际断开连接', '连接中可以打开认证', '关闭浏览器会停止旧请求']
						: []),
				],
			},
			null,
			2,
		),
	);
} catch (error) {
	console.error(error.message);
	throw error;
} finally {
	for (const socket of sockets) {
		socket.destroy();
	}
	await instance?.close().catch(() => {});
	await new Promise((resolve) => server.close(resolve));
	await rm(root, { recursive: true, force: true });
}
