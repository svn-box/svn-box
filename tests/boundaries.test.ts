import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { fixture, finish, svn } from './fixtures';
import { Runner, SvnError } from '../src/main/runner';
import { Store } from '../src/main/store';
import { SvnService } from '../src/main/service';

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
	f = await fixture();
}, 30000);
afterAll(async () => {
	await f?.service.flush();
	f?.runner.shutdown();
	if (f) {
		await rm(f.root, { recursive: true, force: true });
	}
});

describe('写入边界与失败恢复', () => {
	it('目录删除审阅枚举未受控后代，确认后新增文件使确认失效', async () => {
		await writeFile(join(f.a, '目录 空格/未受控笔记.txt'), '不可静默丢弃');
		const review = await f.service.review({ wcId: f.first.id, action: 'delete', paths: ['目录 空格'] });
		expect(review.paths).toContain('目录 空格/未受控笔记.txt');
		await writeFile(join(f.a, '目录 空格/确认后的新文件.txt'), 'new');
		const operation = await finish(f.service, await f.service.execute(review.id));
		expect(operation.state).toBe('failed');
		expect(operation.error?.kind).toBe('stale');
		expect(await readFile(join(f.a, '目录 空格/未受控笔记.txt'), 'utf8')).toBe('不可静默丢弃');
	});
	it('目录重命名的提交审阅列出删除、新增目录及所有后代', async () => {
		const move = await f.service.review({ wcId: f.first.id, action: 'rename', paths: ['目录 空格'], destination: '重命名目录' });
		expect(move.paths).toContain('目录 空格/中文 @ 文件.txt');
		const operation = await finish(f.service, await f.service.execute(move.id));
		expect(operation.state, JSON.stringify(operation)).toBe('success');
		const review = await f.service.review({ wcId: f.first.id, action: 'commit', paths: ['重命名目录/中文 @ 文件.txt'], message: '目录移动' });
		expect(review.paths).toContain('目录 空格');
		expect(review.paths).toContain('目录 空格/中文 @ 文件.txt');
		expect(review.paths).toContain('重命名目录');
		expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
	});
	it('符号链接与嵌套工作副本不能越过操作边界', async () => {
		const outside = join(f.root, '外部数据');
		await mkdir(outside);
		await writeFile(join(outside, 'secret.txt'), 'outside');
		await symlink(outside, join(f.a, '外部链接'));
		await expect(f.service.review({ wcId: f.first.id, action: 'delete', paths: ['外部链接/secret.txt'] })).rejects.toThrow('符号链接');
		await svn('checkout', `${f.url}/trunk@`, join(f.a, '嵌套副本'));
		await expect(f.service.review({ wcId: f.first.id, action: 'delete', paths: ['嵌套副本/README.md'] })).rejects.toThrow('嵌套工作副本');
	});
	it('模拟服务器已提交但响应丢失，结果标记待核实且保留草稿', async () => {
		await writeFile(join(f.b, 'other.txt'), '服务器实际会收到这次提交\n');
		await f.service.saveSession(f.second.id, { draft: '响应丢失的提交', selected: ['other.txt'] });
		const review = await f.service.review({ wcId: f.second.id, action: 'commit', paths: ['other.txt'], message: '响应丢失的提交' });
		const original = f.runner.run.bind(f.runner);
		const spy = vi.spyOn(f.runner, 'run').mockImplementation(async (args, options) => {
			const result = await original(args, options);
			if (args[0] === 'commit') {
				throw new SvnError({ kind: 'network', message: '模拟：服务器响应丢失' });
			}
			return result;
		});
		const operation = await finish(f.service, await f.service.execute(review.id));
		spy.mockRestore();
		expect(operation.state).toBe('uncertain');
		expect(f.store.get().sessions[f.second.id].draft).toBe('响应丢失的提交');
		expect((await f.service.log(f.second.id))[0].message).toBe('响应丢失的提交');
		expect(operation.logs.join('')).toContain('核实');
	});
	it('执行中可取消子进程，也能真实处理超时、stderr 和非零退出', async () => {
		const script = join(f.root, '模拟 svn 可执行文件');
		await writeFile(script, '#!/bin/sh\nprintf "started\\n"\nprintf "diagnostic\\n" >&2\nexec /bin/sleep 15\n');
		await chmod(script, 0o700);
		const controller = new AbortController();
		const chunks: string[] = [];
		const task = f.runner.run([], {
			executable: script,
			signal: controller.signal,
			onData: (text) => {
				chunks.push(text);
				if (text.includes('started')) {
					controller.abort();
				}
			},
		});
		await expect(task).rejects.toMatchObject({ info: { kind: 'cancelled' } });
		expect(chunks.join('')).toContain('started');
		await expect(f.runner.run([], { executable: script, timeout: 30 })).rejects.toMatchObject({ info: { kind: 'network' } });
		await writeFile(script, '#!/bin/sh\nprintf "svn: E170001: Authentication failed\\n" >&2\nexit 1\n');
		await expect(f.runner.run([], { executable: script })).rejects.toMatchObject({ info: { kind: 'auth' } });
	});
	it('应用中断后的运行中任务恢复为结果待核实', async () => {
		const directory = join(f.root, 'recovery-data');
		const store = new Store(directory);
		await store.load();
		await store.change(() => {});
		await writeFile(
			join(directory, 'operations.json'),
			JSON.stringify([{ id: 'interrupted', label: '提交变更', state: 'running', startedAt: new Date().toISOString(), logs: [] }]),
		);
		const service = new SvnService(store, new Runner());
		await service.initialize();
		expect(service.getOperations()[0].state).toBe('uncertain');
	});
	it('真实 svnserve 认证失败可识别；独立凭据通过 stdin 使用，日志没有密码', async () => {
		await writeFile(join(f.repository, 'conf/svnserve.conf'), '[general]\nanon-access = none\nauth-access = write\npassword-db = passwd\nrealm = svnbox-test\n');
		await writeFile(join(f.repository, 'conf/passwd'), '[users]\nsvnbox = 密码-test-123\n');
		const port = await new Promise<number>((resolve) => {
			const server = createServer();
			server.listen(0, '127.0.0.1', () => {
				const address = server.address();
				const port = typeof address === 'object' && address ? address.port : 0;
				server.close(() => resolve(port));
			});
		});
		const server = spawn('/opt/homebrew/bin/svnserve', ['--daemon', '--foreground', '--listen-host', '127.0.0.1', '--listen-port', String(port), '--root', f.repository], {
			stdio: 'ignore',
		});
		for (let attempt = 0; attempt < 60; attempt++) {
			const connected = await new Promise<boolean>((resolve) => {
				const socket = connect(port, '127.0.0.1');
				socket.once('connect', () => {
					socket.destroy();
					resolve(true);
				});
				socket.once('error', () => resolve(false));
			});
			if (connected) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const secret = new Map<string, string>();
		const service = new SvnService(new Store(join(f.root, 'auth-data')), new Runner(), () => {}, {
			get: async (id) => secret.get(id),
			set: async (id, password) => {
				secret.set(id, password);
			},
			delete: async (id) => {
				secret.delete(id);
			},
		});
		try {
			await service.initialize();
			await expect(service.addRepository(`svn://127.0.0.1:${port}/trunk`)).rejects.toMatchObject({ info: { kind: 'auth' } });
			const state = await service.credential({
				rootUrl: `svn://127.0.0.1:${port}`,
				url: `svn://127.0.0.1:${port}/trunk`,
				name: '本地测试',
				username: 'svnbox',
				password: '密码-test-123',
			});
			await service.addRepository(`svn://127.0.0.1:${port}/trunk`, '认证仓库', state.credentials[0].id);
			expect((await service.list(`svn://127.0.0.1:${port}/trunk`, service.store.get().repositories[0].id)).length).toBeGreaterThan(0);
			expect(JSON.stringify(service.store.get())).not.toContain('密码-test-123');
		} finally {
			server.kill();
			service.runner.shutdown();
		}
	});
});
