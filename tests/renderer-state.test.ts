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
		settings: { svnPath: '', theme: 'system', mergeTool: '' },
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
