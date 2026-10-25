import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer, type Socket } from 'node:net';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, finish } from './fixtures';

let f: Awaited<ReturnType<typeof fixture>>;
let daemon: ChildProcess;
let upstreamPort: number;
let url: string;
let forwardedConnections = 0;
const sockets = new Set<Socket>();
const gate = createServer((client) => {
	sockets.add(client);
	client.on('error', () => {});
	client.on('close', () => sockets.delete(client));
	// Match a lazy TCP forwarder: upstream does not open until client data arrives.
	client.once('data', (first) => {
		forwardedConnections++;
		const upstream = connect(upstreamPort, '127.0.0.1');
		sockets.add(upstream);
		upstream.on('error', () => client.destroy());
		upstream.on('close', () => {
			sockets.delete(upstream);
			client.destroy();
		});
		client.on('close', () => upstream.destroy());
		upstream.write(first);
		client.pipe(upstream);
		upstream.pipe(client);
	});
});

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return typeof address === 'object' && address ? address.port : 0;
}

beforeAll(async () => {
	f = await fixture();
	await writeFile(join(f.repository, 'conf/svnserve.conf'), '[general]\nanon-access = write\nauth-access = write\n');
	upstreamPort = await unusedPort();
	daemon = spawn('/opt/homebrew/bin/svnserve', ['--daemon', '--foreground', '--listen-host', '127.0.0.1', '--listen-port', String(upstreamPort), '--root', f.repository], {
		stdio: 'ignore',
	});
	for (let attempt = 0; attempt < 100; attempt++) {
		const ready = await new Promise<boolean>((resolve) => {
			const socket = connect(upstreamPort, '127.0.0.1');
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => resolve(false));
		});
		if (ready) {
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await new Promise<void>((resolve) => gate.listen(0, '127.0.0.1', resolve));
	const address = gate.address();
	url = `svn://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/trunk`;
	const run = f.runner.run.bind(f.runner);
	vi.spyOn(f.runner, 'run').mockImplementation((args, options) => run(args, { ...options, timeout: Math.min(options?.timeout ?? 1500, 1500) }));
}, 30000);

afterAll(async () => {
	f?.runner.shutdown();
	for (const socket of sockets) {
		socket.destroy();
	}
	await new Promise<void>((resolve) => gate.close(() => resolve()));
	daemon?.kill();
	if (f) {
		await rm(f.root, { recursive: true, force: true });
	}
});

it('等待客户端首字节的代理也能浏览真实 SVN 仓库', async () => {
	const files = await f.service.list(url);
	expect(files.map((file) => file.name)).toContain('README.md');
	expect(forwardedConnections).toBeGreaterThan(0);
});

it('同一路由下检出、选择性提交、更新及历史保持真实地址和仓库身份', async () => {
	const firstPath = join(f.root, '转发副本 A @');
	const secondPath = join(f.root, '转发副本 B');
	expect((await finish(f.service, await f.service.checkout({ url, destination: firstPath, depth: 'infinity' }))).state).toBe('success');
	expect((await finish(f.service, await f.service.checkout({ url, destination: secondPath, depth: 'infinity' }))).state).toBe('success');
	const first = f.store.get().workingCopies.find((copy) => copy.path === firstPath)!;
	const second = f.store.get().workingCopies.find((copy) => copy.path === secondPath)!;
	expect(first.url).toBe(url);
	expect(second.repositoryId).toBe(first.repositoryId);
	const path = '目录 空格/中文 @ 文件.txt';
	await writeFile(join(first.path, path), '代理兼容后的真实修改\n');
	await writeFile(join(first.path, 'other.txt'), '本次不提交\n');
	const review = await f.service.review({ wcId: first.id, action: 'commit', paths: [path], message: '等待首字节代理下的选择性提交' });
	expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
	expect((await f.service.status(first.id)).files.find((file) => file.path === 'other.txt')?.item).toBe('modified');
	const update = await f.service.review({ wcId: second.id, action: 'update', paths: [] });
	expect((await finish(f.service, await f.service.execute(update.id))).state).toBe('success');
	expect(await readFile(join(second.path, path), 'utf8')).toBe('代理兼容后的真实修改\n');
	const history = await f.service.log(second.id);
	expect(history[0].message).toBe('等待首字节代理下的选择性提交');
	expect((await f.service.diff(second.id, path, history[0].revision)).text).toContain('+代理兼容后的真实修改');
}, 20000);
