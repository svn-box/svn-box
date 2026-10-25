import { beforeAll, afterAll, expect, it } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, svn, finish } from './fixtures';
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

it('文件 external 的修改不会静默进入父工作副本提交范围', async () => {
	await svn('update', `${f.a}@`, '--ignore-externals');
	await svn('propset', 'svn:externals', '^/trunk/other.txt 外部文件.txt', `${f.a}@`);
	await svn('commit', `${f.a}@`, '--depth', 'empty', '-m', '独立文件 external');
	await svn('update', `${f.b}@`);
	await writeFile(join(f.b, '外部文件.txt'), 'external 的独立修改\n');
	const snapshot = await f.service.status(f.second.id);
	expect(snapshot.files.find((file) => file.path === '外部文件.txt')?.external).toBe(true);
	await expect(f.service.review({ wcId: f.second.id, action: 'commit', paths: ['外部文件.txt'], message: '禁止混入' })).rejects.toThrow('external');
});

it('不同仓库的更新分别排队、分别返回结果', async () => {
	const other = await fixture();
	try {
		await f.service.addWorkingCopy(other.a, '另一个独立仓库');
		const state = f.store.get();
		expect(state.repositories).toHaveLength(2);
		const copy = state.workingCopies.find((copy) => copy.path === other.a)!;
		const a = await f.service.review({ wcId: f.first.id, action: 'update', paths: [] });
		const b = await f.service.review({ wcId: copy.id, action: 'update', paths: [] });
		const oa = await f.service.execute(a.id);
		const ob = await f.service.execute(b.id);
		const results = await Promise.all([finish(f.service, oa), finish(f.service, ob)]);
		expect(results.map((operation) => operation.state)).toEqual(['success', 'success']);
		expect(results[0].wcId).not.toBe(results[1].wcId);
		expect(results[0].id).not.toBe(results[1].id);
	} finally {
		await other.service.flush();
		other.runner.shutdown();
		await rm(other.root, { recursive: true, force: true });
	}
});
