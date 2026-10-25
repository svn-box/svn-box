import { beforeAll, afterAll, expect, it } from 'vitest';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, svn } from './fixtures';
import { Store } from '../src/main/store';
import { Runner } from '../src/main/runner';
import { SvnService } from '../src/main/service';

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
	f = await fixture();
}, 30000);
afterAll(async () => {
	await f.service.flush();
	f.runner.shutdown();
	await rm(f.root, { recursive: true, force: true });
});

it('远端路径书签独立于仓库根 URL 保存，可重命名、恢复和移除', async () => {
	const repo = f.store.get().repositories[0];
	const url = `${repo.rootUrl}/trunk/${encodeURIComponent('目录 空格')}`;
	let state = await f.service.bookmark({ repositoryId: repo.id, url, name: '主干文档' });
	expect(state.bookmarks[0].url).toBe(url);
	expect(state.repositories[0].rootUrl).toBe(repo.rootUrl);
	state = await f.service.bookmark({ repositoryId: repo.id, url, name: '重命名的路径' });
	expect(state.bookmarks).toHaveLength(1);
	const restored = new SvnService(new Store(f.store.directory), new Runner());
	await restored.initialize();
	expect(restored.store.get().bookmarks[0].name).toBe('重命名的路径');
	await expect(f.service.bookmark({ repositoryId: repo.id, url: 'file:///etc', name: '越界' })).rejects.toThrow('超出');
	state = await f.service.bookmark({ ...state.bookmarks[0], remove: true });
	expect(state.bookmarks).toHaveLength(0);
	expect(state.workingCopies).toHaveLength(2);
});

it('添加分支 URL 自动保存精确路径，路径排序重启后保留', async () => {
	const repo = f.store.get().repositories[0];
	let state = await f.service.addRepository(`${repo.rootUrl}/trunk`);
	expect(state.repositories).toHaveLength(1);
	expect(state.bookmarks[0].url).toBe(`${repo.rootUrl}/trunk`);
	state = await f.service.bookmark({ repositoryId: repo.id, url: `${repo.rootUrl}/trunk/${encodeURIComponent('目录 空格')}`, name: '子目录' });
	state = await f.service.bookmark({ ...state.bookmarks[1], direction: 'up' });
	expect(state.bookmarks[0].name).toBe('子目录');
	const restored = new Store(f.store.directory);
	await restored.load();
	expect(restored.get().bookmarks.map((bookmark) => bookmark.url)).toEqual(state.bookmarks.map((bookmark) => bookmark.url));
	for (const bookmark of state.bookmarks) {
		await f.service.bookmark({ ...bookmark, remove: true });
	}
});

it('旧版工作区迁移补齐路径书签，并保留草稿和文件树上下文', async () => {
	const state = f.store.get();
	await f.service.saveSession(f.first.id, { draft: '需要恢复的草稿', expanded: ['.', '目录 空格'], lastFileView: 'files', treeInitialized: true });
	const old = f.store.get() as any;
	delete old.bookmarks;
	await writeFile(join(f.store.directory, 'workspace.json'), JSON.stringify(old));
	const restored = new Store(f.store.directory);
	await restored.load();
	expect(restored.get().bookmarks).toEqual([]);
	expect(restored.get().sessions[f.first.id].draft).toBe('需要恢复的草稿');
	expect(restored.get().sessions[f.first.id].expanded).toEqual(['.', '目录 空格']);
	expect(state.repositories).toHaveLength(1);
});

it('FileMerge 的本地输入是真实 BASE 与工作文件的只读快照', async () => {
	const path = '目录 空格/中文 @ 文件.txt';
	await writeFile(join(f.a, path), 'FileMerge 本地修改\n');
	const comparison = await f.service.comparison(f.first.id, path);
	expect(await readFile(comparison.left, 'utf8')).toContain('共享的内容');
	expect(await readFile(comparison.right, 'utf8')).toBe('FileMerge 本地修改\n');
	expect((await stat(comparison.left)).mode & 0o222).toBe(0);
	expect((await stat(comparison.right)).mode & 0o222).toBe(0);
	expect(await readFile(join(f.a, path), 'utf8')).toBe('FileMerge 本地修改\n');
	await expect(f.service.comparison(f.first.id, '..')).rejects.toThrow('允许范围');
	await expect(f.service.comparison(f.first.id, '目录 空格')).rejects.toThrow('普通文件');
});

it('FileMerge 历史比较读取指定提交两侧，删除提交的右侧为空', async () => {
	const path = '目录 空格/中文 @ 文件.txt';
	await svn('commit', `${f.a}/${path}@`, '-m', 'FileMerge 历史基线');
	const revision = (await f.service.log(f.first.id))[0].revision;
	let comparison = await f.service.comparison(f.first.id, path, revision);
	expect(await readFile(comparison.left, 'utf8')).toContain('共享的内容');
	expect(await readFile(comparison.right, 'utf8')).toBe('FileMerge 本地修改\n');
	await svn('delete', `${f.a}/${path}@`);
	await svn('commit', `${f.a}/${path}@`, '-m', 'FileMerge 删除比较');
	const deletion = (await f.service.log(f.first.id))[0].revision;
	comparison = await f.service.comparison(f.first.id, path, deletion);
	expect(await readFile(comparison.left, 'utf8')).toBe('FileMerge 本地修改\n');
	expect(await readFile(comparison.right, 'utf8')).toBe('');
});
