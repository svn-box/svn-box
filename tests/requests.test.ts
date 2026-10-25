import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { rm } from 'node:fs/promises';
import { fixture } from './fixtures';
import { Store } from '../src/main/store';
import { Runner } from '../src/main/runner';
import { SvnService } from '../src/main/service';
import { join } from 'node:path';

let f: Awaited<ReturnType<typeof fixture>>;
const sockets = new Set<Socket>();
let totalConnections = 0;
const server = createServer((socket) => {
	totalConnections++;
	sockets.add(socket);
	socket.resume();
	socket.on('close', () => sockets.delete(socket));
});
let url: string;

async function waitUntil(predicate: () => boolean) {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('请求没有及时结束');
}

beforeAll(async () => {
	f = await fixture();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	url = `svn://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 30000);

afterAll(async () => {
	for (const socket of sockets) {
		socket.destroy();
	}
	await new Promise<void>((resolve) => server.close(() => resolve()));
	f?.runner.shutdown();
	if (f) {
		await rm(f.root, { recursive: true, force: true });
	}
});

it('服务器不回应时，本机保存凭据不发起网络验证', async () => {
	const secrets = new Map<string, string>();
	const runner = new Runner();
	const service = new SvnService(new Store(join(f.root, 'save-without-network')), runner, () => {}, {
		get: async (id) => secrets.get(id),
		set: async (id, password) => {
			secrets.set(id, password);
		},
		delete: async (id) => {
			secrets.delete(id);
		},
	});
	await service.initialize();
	const spy = vi.spyOn(runner, 'run');
	const before = totalConnections;
	const state = await service.credential({ rootUrl: url, url, username: 'offline-user', password: 'temporary-offline-secret' });
	expect(spy).not.toHaveBeenCalled();
	expect(totalConnections).toBe(before);
	expect(secrets.get(state.credentials[0].id)).toBe('temporary-offline-secret');
	expect(JSON.stringify(state)).not.toContain('temporary-offline-secret');
	runner.shutdown();
});

it('停止真实 SVN 只读连接会终止子进程，并释放查询槽', async () => {
	const pending = f.service.withRequest('cancel-running', 'list', () => f.service.list(url));
	const result = pending.catch((error) => error);
	await waitUntil(() => sockets.size === 1);
	f.service.cancelRequest('cancel-running');
	expect((await result).info.kind).toBe('cancelled');
	await waitUntil(() => sockets.size === 0);
	expect((await f.service.list(f.url)).length).toBeGreaterThan(0);
});

it('快速取消发生在 IPC 请求到达前，也不能留下新连接', async () => {
	const before = totalConnections;
	f.service.cancelRequest('cancel-before-start');
	await expect(f.service.withRequest('cancel-before-start', 'list', () => f.service.list(url))).rejects.toMatchObject({ info: { kind: 'cancelled' } });
	expect(totalConnections).toBe(before);
});

it('运行中和排队中的读取都能停止，不阻塞其他项目', async () => {
	const before = totalConnections;
	const jobs = Array.from({ length: 4 }, (_, index) => f.service.withRequest(`queue-${index}`, 'list', () => f.service.list(url)).catch((error) => error));
	await waitUntil(() => sockets.size === 3);
	for (let index = 0; index < 4; index++) {
		f.service.cancelRequest(`queue-${index}`);
	}
	const results = await Promise.all(jobs);
	expect(results.every((error) => error.info.kind === 'cancelled')).toBe(true);
	await waitUntil(() => sockets.size === 0);
	expect(totalConnections - before).toBe(3);
	expect((await f.service.list(f.url)).length).toBeGreaterThan(0);
});
