import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, finish, svn } from './fixtures';
import { SvnService } from '../src/main/service';
import { Store } from '../src/main/store';
import { Runner } from '../src/main/runner';
import { operationDuration, operationOutput } from '../src/renderer/src/lib/operation-log';
import { appendOperationLog } from '../src/main/operation-logs';
import type { Operation } from '../src/shared/types';

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
	f = await fixture();
}, 30000);

afterAll(async () => {
	if (f) {
		await f.service.flush();
		f.runner.shutdown();
		await rm(f.root, { recursive: true, force: true });
	}
});

async function update(wcId: string) {
	const review = await f.service.review({ wcId, action: 'update', paths: [] });
	return f.service.execute(review.id);
}

describe('日志清空与持久化', () => {
	it('只删除确认快照内的终态，保留运行/等待任务与后续输出，重启不复活', async () => {
		const completed = await finish(f.service, await update(f.first.id));
		const other = await finish(f.service, await update(f.second.id));
		await f.service.flush();
		let release!: () => void;
		let entered!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const original = f.runner.run.bind(f.runner);
		const spy = vi.spyOn(f.runner, 'run').mockImplementation(async (args, options) => {
			if (args[0] === 'update') {
				entered();
				await gate;
			}
			return original(args, options);
		});
		try {
			const running = await update(f.first.id);
			await started;
			const waiting = await update(f.first.id);
			expect(f.service.getOperations().find((operation) => operation.id === waiting.id)?.state).toBe('waiting');
			const result = await f.service.clearOperations({ ids: [completed.id, running.id, waiting.id] });
			expect(result.removedIds).toEqual([completed.id]);
			expect(result.operations.map((operation) => operation.id)).toEqual(expect.arrayContaining([other.id, running.id, waiting.id]));
			release();
			expect((await finish(f.service, running)).state).toBe('success');
			expect((await finish(f.service, waiting)).state).toBe('success');
			await f.service.flush();
			const disk = JSON.parse(await readFile(join(f.store.directory, 'operations.json'), 'utf8')) as Operation[];
			expect(disk.map((operation) => operation.id)).not.toContain(completed.id);
			expect(disk.find((operation) => operation.id === running.id)?.logs.join('')).toContain('revision');
			const restored = new SvnService(new Store(f.store.directory), new Runner());
			await restored.initialize();
			expect(restored.getOperations().map((operation) => operation.id)).toEqual(disk.map((operation) => operation.id));
			expect(await svn('status', `${f.a}@`)).toBe('');
		} finally {
			release();
			spy.mockRestore();
		}
	});

	it('高频输出合并持久化快照，最终状态与完整输出仍落盘', async () => {
		await f.service.flush();
		const persistence = f.service as unknown as { writeOperations(operations: Operation[]): Promise<void> };
		const writes = vi.spyOn(persistence, 'writeOperations');
		const original = f.runner.run.bind(f.runner);
		const runner = vi.spyOn(f.runner, 'run').mockImplementation(async (args, options) => {
			if (args[0] === 'update') {
				for (let index = 0; index < 250; index++) {
					options?.onData?.(`批次 ${index}: ${'x'.repeat(2048)}\n`);
				}
			}
			return original(args, options);
		});
		try {
			const result = await finish(f.service, await update(f.first.id));
			await f.service.flush();
			expect(result.state).toBe('success');
			expect(result.sequence).toBeGreaterThan(250);
			expect(writes.mock.calls.length).toBeLessThan(12);
			const disk = JSON.parse(await readFile(join(f.store.directory, 'operations.json'), 'utf8')) as Operation[];
			const stored = disk.find((operation) => operation.id === result.id)!;
			expect(stored).toEqual(result);
			expect(stored.logs.join('')).toContain('批次 0:');
			expect(stored.logs.join('')).toContain('批次 249:');
		} finally {
			writes.mockRestore();
			runner.mockRestore();
		}
	});

	it('flush 等待期间加入的下一次写盘也必须完成', async () => {
		await f.service.flush();
		const persistence = f.service as unknown as { operationWrites: Promise<void> };
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		persistence.operationWrites = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let flushed = false;
		const task = f.service.flush().then(() => {
			flushed = true;
		});
		persistence.operationWrites = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		releaseFirst();
		await Promise.resolve();
		await Promise.resolve();
		expect(flushed).toBe(false);
		releaseSecond();
		await task;
		expect(flushed).toBe(true);
	});

	it('磁盘清空失败保留内存与磁盘，修复后可以重试', async () => {
		await f.service.flush();
		const before = f.service.getOperations();
		const disk = await readFile(join(f.store.directory, 'operations.json'), 'utf8');
		const blocked = join(f.store.directory, 'operations.json.tmp');
		await mkdir(blocked);
		try {
			await expect(f.service.clearOperations({ ids: before.map((operation) => operation.id) })).rejects.toThrow();
			expect(f.service.getOperations()).toEqual(before);
			expect(await readFile(join(f.store.directory, 'operations.json'), 'utf8')).toBe(disk);
		} finally {
			await rm(blocked, { recursive: true });
		}
		const result = await f.service.clearOperations({ ids: before.map((operation) => operation.id) });
		expect(result.removedIds).toHaveLength(before.length);
		expect(JSON.parse(await readFile(join(f.store.directory, 'operations.json'), 'utf8'))).toEqual([]);
	});
});

describe('日志文本与真实历时', () => {
	it('原始 stderr 与错误详情不重复，额外诊断仍保留', () => {
		const operation = { logs: ['start\r\nsvn: E123: failed\n'], error: { detail: 'svn: E123: failed\nextra diagnosis' } } as Operation;
		expect(operationOutput(operation)).toBe('start\nsvn: E123: failed\nextra diagnosis');
		expect(operationOutput({ ...operation, logs: [] })).toBe('svn: E123: failed\nextra diagnosis');
	});

	it('中断恢复没有结束时间时不虚构历时，运行与完成按真实时间计算', () => {
		const operation = { startedAt: '2026-10-26T00:00:00Z', state: 'running' } as Operation;
		const now = Date.parse(operation.startedAt) + 65000;
		expect(operationDuration(operation, now)).toBe('1 分 5 秒');
		expect(operationDuration({ ...operation, state: 'uncertain' }, now)).toBe('—');
		expect(operationDuration({ ...operation, state: 'success', endedAt: '2026-10-26T00:00:00.500Z' }, now)).toBe('0.5 秒');
	});
});

describe('命令输出限额', () => {
	it('高频小片段不丢4000行，限额后提示并保留完整Unicode结尾', () => {
		const logs: string[] = [];
		for (let index = 0; index < 4000; index++) {
			appendOperationLog(logs, `更新 中文 @ 文件 ${index}\n`);
		}
		expect(logs.join('').split('\n')).toHaveLength(4001);
		expect(logs.length).toBeLessThan(20);
		appendOperationLog(logs, '😀'.repeat(600000));
		appendOperationLog(logs, '\n最终输出\n');
		const output = logs.join('');
		expect(output).toContain('较早的命令输出已省略');
		expect(output.split('较早的命令输出已省略')).toHaveLength(2);
		expect(output).toHaveLength(1024 * 1024 + logs[0].length);
		expect(output.endsWith('最终输出\n')).toBe(true);
		expect(output).toBe(Buffer.from(output, 'utf8').toString('utf8'));
	});
});
