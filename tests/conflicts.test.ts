import { beforeAll, afterAll, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, finish, svn } from './fixtures';
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

it('识别真实属性冲突及冲突详情，接受人工修正后的工作属性', async () => {
	await svn('propset', 'svnbox:tag', 'base', `${f.a}/README.md@`);
	await svn('commit', `${f.a}/README.md@`, '-m', '属性基线');
	await svn('update', `${f.b}@`, '--ignore-externals');
	await svn('propset', 'svnbox:tag', 'remote', `${f.a}/README.md@`);
	await svn('commit', `${f.a}/README.md@`, '-m', '上游属性修改');
	await svn('propset', 'svnbox:tag', 'local', `${f.b}/README.md@`);
	const review = await f.service.review({ wcId: f.second.id, action: 'update', paths: [] });
	expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
	expect((await f.service.status(f.second.id)).files.find((file) => file.path === 'README.md')?.props).toBe('conflicted');
	expect((await f.service.info(f.second.id, 'README.md')).conflicts.length).toBeGreaterThan(0);
	await svn('propset', 'svnbox:tag', 'resolved', `${f.b}/README.md@`);
	const resolve = await f.service.review({ wcId: f.second.id, action: 'resolve', paths: ['README.md'] });
	expect((await finish(f.service, await f.service.execute(resolve.id))).state).toBe('success');
	expect((await f.service.status(f.second.id)).files.find((file) => file.path === 'README.md')?.props).toBe('modified');
});

it('本地修改与上游删除产生树冲突，拒绝直接提交并保留详情', async () => {
	await writeFile(join(f.b, 'README.md'), '本地修改，不能静默丢失\n');
	await svn('delete', `${f.a}/README.md@`);
	await svn('commit', `${f.a}/README.md@`, '-m', '上游删除说明');
	const review = await f.service.review({ wcId: f.second.id, action: 'update', paths: [] });
	expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
	const file = (await f.service.status(f.second.id)).files.find((file) => file.path === 'README.md');
	expect(file?.treeConflicted).toBe(true);
	expect((await f.service.info(f.second.id, 'README.md')).conflicts.length).toBeGreaterThan(0);
	await expect(f.service.review({ wcId: f.second.id, action: 'commit', paths: ['README.md'], message: '不能提交冲突' })).rejects.toThrow('冲突');
});
