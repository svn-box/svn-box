import { afterEach, describe, expect, it, vi } from 'vitest';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { createWorkspaceStore } from '../src/renderer/src/state/workspace-store';
import { createSvnQueries, mergeOperations, queryKeys } from '../src/renderer/src/queries/svn-queries';
import { emptySession, type AppState, type FileStatus, type LogEntry, type Operation, type Snapshot } from '../src/shared/types';
import type { ClientCall } from '../src/renderer/src/lib/api-types';

function workspace(): AppState {
	return {
		version: 1,
		activeId: 'a',
		repositories: [{ id: 'repo', name: '仓库', rootUrl: 'file:///repo', uuid: 'uuid', favorite: false }],
		workingCopies: ['a', 'b'].map((id) => ({ id, name: id, path: `/${id}`, repositoryId: 'repo', url: 'file:///repo/trunk', depth: 'infinity', favorite: false })),
		sessions: { a: emptySession(), b: emptySession() },
		bookmarks: [],
		groups: [],
		credentials: [],
		recentMessages: [],
		settings: { svnPath: '', theme: 'light', mergeTool: '' },
	};
}

function file(path: string, item = 'modified'): FileStatus {
	return { path, item, props: 'none', revision: '1', author: '', date: '', kind: 'file', copied: false, switched: false, treeConflicted: false, external: false };
}

function snapshot(wcId: string, scannedAt = '2026-10-25T00:00:00.000Z'): Snapshot {
	return { wcId, scannedAt, fingerprint: scannedAt, files: [file('src/中文 @ 文件.ts'), file('normal.txt', 'normal')] };
}

const clients: QueryClient[] = [];
afterEach(() => {
	clients.splice(0).forEach((client) => client.clear());
	onlineManager.setOnline(true);
});

describe('渲染进程会话一致性', () => {
	it('更新准备锁在同一次调用中生效，按副本隔离，旧准备结果不能解锁新的请求', () => {
		const store = createWorkspaceStore(vi.fn() as ClientCall, vi.fn());
		store.getState().accept(workspace());
		expect(store.getState().beginUpdate('a', 'first')).toBe(true);
		expect(store.getState().beginUpdate('a', 'duplicate')).toBe(false);
		expect(store.getState().beginUpdate('b', 'other')).toBe(true);
		store.getState().finishUpdatePreparation('a', 'first');
		expect(store.getState().updateIntents.b.preparing).toBe(true);
		expect(store.getState().beginUpdate('a', 'retry')).toBe(true);
		store.getState().finishUpdatePreparation('a', 'first');
		expect(store.getState().updateIntents.a).toEqual({ preparing: true, toastId: 'retry' });
	});

	it('执行确认前后共用更新 toast，另一个操作不能覆盖其绑定', () => {
		const store = createWorkspaceStore(vi.fn() as ClientCall, vi.fn());
		store.getState().accept(workspace());
		store.getState().beginUpdate('a', 'toast');
		expect(store.getState().bindUpdateOperation('a', 'operation')).toBe('toast');
		store.getState().finishUpdatePreparation('a', 'toast');
		expect(store.getState().bindUpdateOperation('a', 'operation')).toBe('toast');
		expect(store.getState().bindUpdateOperation('a', 'another')).toBeUndefined();
		expect(store.getState().updateIntents.a.operationId).toBe('operation');
	});

	it('旧元数据与保存响应不能覆盖当前副本、较新的草稿或另一份会话', async () => {
		const pending: (() => void)[] = [];
		const call = vi.fn((method, input) =>
			method === 'session' ? new Promise((resolve) => pending.push(() => resolve({ ...emptySession(), ...input.patch }))) : Promise.resolve(),
		) as ClientCall;
		const store = createWorkspaceStore(call, vi.fn());
		store.getState().accept(workspace());
		const other = store.getState().sessions.b;
		store.getState().patchSession({ draft: '第一稿' }, 'a');
		store.getState().patchSession({ draft: '第二稿', selected: ['src/中文 @ 文件.ts'] }, 'a');
		store.getState().activate('b');
		store.getState().accept(workspace());
		pending.reverse().forEach((resolve) => resolve());
		await store.getState().flushSessions();
		expect(store.getState().activeId).toBe('b');
		expect(store.getState().sessions.a.draft).toBe('第二稿');
		expect(store.getState().sessions.b).toBe(other);
	});

	it('成功提交只清除提交开始时的草稿；提交期间新写的草稿会重新保存', async () => {
		const call = vi.fn(async () => emptySession()) as ClientCall;
		const store = createWorkspaceStore(call, vi.fn());
		store.getState().accept(workspace());
		store.getState().patchSession({ draft: '正在提交', selected: ['one'] }, 'a');
		const captured = store.getState().checkpoint('a');
		store.getState().patchSession({ draft: '下一次提交的新草稿' }, 'a');
		const success = { id: 'op', wcId: 'a', label: '提交变更', state: 'success' } as Operation;
		store.getState().acceptCommit(workspace(), success, captured);
		await store.getState().flushSessions();
		expect(store.getState().sessions.a.draft).toBe('下一次提交的新草稿');
		expect(call).toHaveBeenLastCalledWith('session', expect.objectContaining({ wcId: 'a', patch: expect.objectContaining({ draft: '下一次提交的新草稿' }) }));
		const next = store.getState().checkpoint('a');
		store.getState().acceptCommit(workspace(), success, next);
		expect(store.getState().sessions.a.draft).toBe('');
	});

	it('刷新重新验证选择并保留另一个项目，失败/待核实提交保留草稿', async () => {
		const call = vi.fn(async () => emptySession()) as ClientCall;
		const store = createWorkspaceStore(call, vi.fn());
		const initial = workspace();
		initial.sessions.a = { ...emptySession(), selected: ['src/中文 @ 文件.ts', 'normal.txt', 'gone'], draft: '保留说明' };
		initial.sessions.b.draft = '另一个项目';
		store.getState().accept(initial);
		store.getState().acceptSnapshot(snapshot('a'));
		await store.getState().flushSessions();
		expect(store.getState().sessions.a.selected).toEqual(['src/中文 @ 文件.ts']);
		expect(store.getState().sessions.a.expanded).toContain('src');
		store.getState().acceptCommit(workspace(), { wcId: 'a', state: 'uncertain', label: '提交变更' } as Operation, store.getState().checkpoint('a'));
		expect(store.getState().sessions.a.draft).toBe('保留说明');
		expect(store.getState().sessions.b.draft).toBe('另一个项目');
	});

	it('持久化失败阻止审阅，后续完整会话保存成功后恢复', async () => {
		let fail = true;
		const call = vi.fn(async () => {
			if (fail) {
				throw new Error('磁盘不可写');
			}
			return emptySession();
		}) as ClientCall;
		const store = createWorkspaceStore(call, vi.fn());
		store.getState().accept(workspace());
		store.getState().patchSession({ draft: '未丢失的说明' }, 'a');
		await expect(store.getState().flushSessions('a')).rejects.toThrow('磁盘不可写');
		fail = false;
		store.getState().patchSession({ currentPath: 'file' }, 'a');
		await store.getState().flushSessions('a');
		expect(call).toHaveBeenLastCalledWith('session', expect.objectContaining({ patch: expect.objectContaining({ draft: '未丢失的说明' }) }));
	});
});

describe('SVN Query 缓存与请求', () => {
	it('同一查询去重，副本/本地历史 Diff/扫描代次分别缓存', async () => {
		const call = vi.fn(async (_method, input) => ({ text: JSON.stringify(input) })) as ClientCall;
		const queries = createSvnQueries(call);
		clients.push(queries.client);
		const first = queries.diffOptions('a', '中文 @.ts', 'scan1');
		await Promise.all([queries.client.fetchQuery(first), queries.client.fetchQuery(first)]);
		expect(call).toHaveBeenCalledTimes(1);
		await queries.client.fetchQuery(queries.diffOptions('b', '中文 @.ts', 'scan1'));
		await queries.client.fetchQuery(queries.diffOptions('a', '中文 @.ts', 'scan2'));
		await queries.client.fetchQuery(queries.diffOptions('a', '中文 @.ts', '', 12));
		expect(call).toHaveBeenCalledTimes(4);
	});

	it('取消将 AbortSignal 传给 IPC，旧结果不进入缓存', async () => {
		let aborted = false;
		let finish!: () => void;
		const call = vi.fn(
			(_method, input, options) =>
				new Promise((resolve) => {
					options.signal.addEventListener('abort', () => {
						aborted = true;
					});
					finish = () => resolve(snapshot(input.wcId));
				}),
		) as ClientCall;
		const accepted = vi.fn();
		const queries = createSvnQueries(call, accepted);
		clients.push(queries.client);
		const promise = queries.client.fetchQuery(queries.statusOptions('a')).catch(() => undefined);
		await queries.client.cancelQueries({ queryKey: queryKeys.status('a') });
		finish();
		await promise;
		await Promise.resolve();
		expect(aborted).toBe(true);
		expect(accepted).not.toHaveBeenCalled();
		expect(queries.client.getQueryData(queryKeys.status('a'))).toBeUndefined();
	});

	it('本地扫描可离线执行；错误不自动重试；远端检查与本地缓存分开', async () => {
		const call = vi.fn(async (_method, input) => ({ ...snapshot(input.wcId), remote: !!input.remote, remoteChanges: input.remote ? 3 : undefined })) as ClientCall;
		const queries = createSvnQueries(call);
		clients.push(queries.client);
		onlineManager.setOnline(false);
		await queries.client.fetchQuery(queries.statusOptions('a'));
		await queries.client.fetchQuery(queries.statusOptions('a', true));
		expect(queries.client.getQueryData<Snapshot>(queryKeys.status('a'))?.remote).toBe(false);
		expect(queries.client.getQueryData<Snapshot>(queryKeys.status('a', true))?.remoteChanges).toBe(3);
		const failed = vi.fn(async () => {
			throw new Error('网络失败');
		}) as ClientCall;
		const failing = createSvnQueries(failed);
		clients.push(failing.client);
		await expect(failing.client.fetchQuery(failing.listOptions('svn://server/repo'))).rejects.toThrow('网络失败');
		expect(failed).toHaveBeenCalledTimes(1);
	});

	it('初始操作列表不能覆盖先到达的成功事件', () => {
		const running = { id: 'op', state: 'running', startedAt: '2026-10-25T00:00:00Z', logs: ['working'] } as Operation;
		const completed = { ...running, state: 'success', endedAt: '2026-10-25T00:00:01Z', logs: ['working', 'done'] } as Operation;
		expect(mergeOperations([running], [completed])).toEqual([completed]);
	});

	it('分页使用上一页最小修订号减一，路径与副本各自保存分页缓存', async () => {
		const call = vi.fn(async (_method, input) => {
			const start = input.before ?? 100;
			return Array.from({ length: Math.min(50, start) }, (_, index) => ({ revision: start - index, author: '测试', date: '', message: '', paths: [] }));
		}) as ClientCall;
		const queries = createSvnQueries(call);
		clients.push(queries.client);
		const options = queries.historyOptions('a', '中文 @ 目录');
		const result = await queries.client.fetchInfiniteQuery({ ...options, pages: 2 });
		expect(result.pages.flat().map((entry) => entry.revision)).toEqual(Array.from({ length: 100 }, (_, index) => 100 - index));
		expect(call).toHaveBeenNthCalledWith(2, 'log', { wcId: 'a', path: '中文 @ 目录', before: 50 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
		await queries.client.fetchInfiniteQuery(queries.historyOptions('b', '.'));
		await queries.client.fetchInfiniteQuery(queries.historyOptions('a', 'other'));
		expect(queries.client.getQueryData<{ pages: LogEntry[][] }>(options.queryKey)?.pages).toHaveLength(2);
	});

	it('写操作只使目标副本缓存失效；失败操作保留历史，成功操作才重查历史', async () => {
		const call = vi.fn(async (method, input) => (method === 'status' ? snapshot(input.wcId, 'new-scan') : method === 'log' ? [] : { text: 'old' })) as ClientCall;
		const queries = createSvnQueries(call);
		clients.push(queries.client);
		const history = queries.historyOptions('a', '.');
		const a = queries.diffOptions('a', 'file', 'old-scan');
		const b = queries.diffOptions('b', 'file', 'old-scan');
		await queries.client.fetchInfiniteQuery(history);
		await queries.client.fetchQuery(a);
		await queries.client.fetchQuery(b);
		await queries.invalidateWorkingCopy('a', false);
		expect(queries.client.getQueryState(a.queryKey)?.isInvalidated).toBe(true);
		expect(queries.client.getQueryState(b.queryKey)?.isInvalidated).toBe(false);
		expect(queries.client.getQueryState(history.queryKey)?.isInvalidated).toBe(false);
		expect(queries.client.getQueryData<Snapshot>(queryKeys.status('a'))?.scannedAt).toBe('new-scan');
		await queries.invalidateWorkingCopy('a', true);
		expect(queries.client.getQueryState(history.queryKey)?.isInvalidated).toBe(true);
		await queries.client.fetchInfiniteQuery(history);
		expect(queries.client.getQueryState(history.queryKey)?.isInvalidated).toBe(false);
		await queries.verifyHistory('a');
		expect(queries.client.getQueryState(history.queryKey)?.isInvalidated).toBe(true);
	});
});

describe('操作日志清空缓存一致性', () => {
	const old = { id: 'old', state: 'success', startedAt: '2026-10-25T00:00:00Z', endedAt: '2026-10-25T00:00:01Z', logs: ['done'] } as Operation;

	it('延迟查询和重复事件不能复活已清空日志，并发新增任务不丢失', async () => {
		let resolveList!: (operations: Operation[]) => void;
		let finishClear!: (result: unknown) => void;
		const call = vi.fn((method) =>
			method === 'operations'
				? new Promise((resolve) => {
						resolveList = resolve;
					})
				: new Promise((resolve) => {
						finishClear = resolve;
					}),
		) as ClientCall;
		const queries = createSvnQueries(call);
		clients.push(queries.client);
		queries.acceptOperation(old);
		const late = queries.client.fetchQuery({ ...queries.operationOptions(), staleTime: 0 }).catch(() => undefined);
		const clearing = queries.clearOperations(['old']);
		await vi.waitFor(() => expect(finishClear).toBeTypeOf('function'));
		const running = { ...old, id: 'new', state: 'running', endedAt: undefined } as Operation;
		queries.acceptOperation(running);
		finishClear({ removedIds: ['old'], operations: [] });
		await clearing;
		resolveList([old]);
		await late;
		await Promise.resolve();
		expect(queries.acceptOperation(old)).toBeUndefined();
		expect(queries.client.getQueryData<Operation[]>(queryKeys.operations)?.map((operation) => operation.id)).toEqual(['new']);
		const reload = queries.client.fetchQuery({ ...queries.operationOptions(), staleTime: 0 });
		resolveList([old, running]);
		expect((await reload).map((operation) => operation.id)).toEqual(['new']);
	});

	it('清空失败不丢记录，旧的运行任务不被最近100条终态挤掉', async () => {
		const queries = createSvnQueries(
			vi.fn(async () => {
				throw new Error('磁盘不可写');
			}) as ClientCall,
		);
		clients.push(queries.client);
		queries.acceptOperation(old);
		await expect(queries.clearOperations(['old'])).rejects.toThrow('磁盘不可写');
		expect(queries.client.getQueryData(queryKeys.operations)).toEqual([old]);
		expect(queries.acceptOperation(old)).toEqual(old);
		const many = Array.from({ length: 110 }, (_, index) => ({ ...old, id: String(index), startedAt: '2026-10-26T00:00:00Z' }));
		const active = { ...old, state: 'running', endedAt: undefined } as Operation;
		const merged = mergeOperations(many, [active]);
		expect(merged).toHaveLength(101);
		expect(merged).toContainEqual(active);
	});
});

describe('操作事件时序与保留上限', () => {
	const running = { id: 'old', label: '更新工作副本', state: 'running', startedAt: '2026-10-25T00:00:00Z', sequence: 2, logs: [] } as Operation;

	it('迟到的 execute 排队响应不能覆盖正在执行的事件，兼容旧记录', () => {
		const waiting = { ...running, state: 'waiting', sequence: 1 } as Operation;
		expect(mergeOperations([waiting], [running])).toEqual([running]);
		expect(mergeOperations([{ ...waiting, sequence: undefined }], [{ ...running, sequence: undefined }])).toEqual([{ ...running, sequence: undefined }]);
	});

	it('日志到达截断上限后仍按序号接收较短的新输出', () => {
		const full = { ...running, logs: ['older output'], sequence: 3 };
		const truncated = { ...running, logs: ['new tail'], sequence: 4 };
		expect(mergeOperations([truncated], [full])).toEqual([truncated]);
		expect(mergeOperations([full], [truncated])).toEqual([truncated]);
	});

	it('查询先看到终态时，迟到的运行事件不能占用真正终态的处理序号', () => {
		const queries = createSvnQueries(vi.fn() as ClientCall);
		clients.push(queries.client);
		queries.acceptOperation(running);
		const completed = { ...running, state: 'success', endedAt: '2026-10-26T00:00:02Z', sequence: 4 } as Operation;
		queries.client.setQueryData(queryKeys.operations, [completed]);
		expect(queries.acceptOperation({ ...running, sequence: 3 })).toBeUndefined();
		expect(queries.acceptOperation(completed)).toEqual(completed);
		expect(queries.acceptOperation(completed)).toBeUndefined();
		const boot = createSvnQueries(vi.fn() as ClientCall);
		clients.push(boot.client);
		boot.client.setQueryData(queryKeys.operations, [completed]);
		expect(boot.acceptOperation(completed)).toEqual(completed);
	});

	it('满额后长任务终态仍交给运行时处理，旧排队响应和重复终态不能复活任务', () => {
		const queries = createSvnQueries(vi.fn() as ClientCall);
		clients.push(queries.client);
		queries.acceptOperation(running);
		for (let index = 0; index < 101; index++) {
			queries.acceptOperation({ ...running, id: `new-${index}`, state: 'success', startedAt: '2026-10-26T00:00:00Z', endedAt: '2026-10-26T00:00:01Z', sequence: 3 });
		}
		const completed = { ...running, state: 'success', endedAt: '2026-10-26T00:00:02Z', sequence: 3 } as Operation;
		expect(queries.acceptOperation(completed)).toEqual(completed);
		expect(queries.client.getQueryData<Operation[]>(queryKeys.operations)).toHaveLength(100);
		expect(queries.acceptOperation({ ...running, state: 'waiting', sequence: 1 })).toBeUndefined();
		expect(queries.acceptOperation(completed)).toBeUndefined();
		expect(queries.client.getQueryData<Operation[]>(queryKeys.operations)?.some((operation) => operation.id === running.id)).toBe(false);
	});
});
