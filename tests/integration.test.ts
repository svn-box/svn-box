import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, finish, svn } from './fixtures';
import { SvnService } from '../src/main/service';
import { Store } from '../src/main/store';
import { Runner, classify } from '../src/main/runner';

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

describe('真实 SVN 多工作副本闭环', () => {
	it('识别相同仓库的两个副本、根路径及特殊字符路径', async () => {
		expect(f.store.get().repositories).toHaveLength(1);
		expect(f.store.get().workingCopies).toHaveLength(2);
		const info = await f.service.info(f.first.id, '目录 空格/中文 @ 文件.txt');
		expect(info.rootPath).toBe(f.a);
		expect(info.uuid).toBeTruthy();
		const snapshot = await f.service.status(f.first.id);
		expect(snapshot.files.find((file) => file.path === '目录 空格/中文 @ 文件.txt')?.item).toBe('normal');
	});
	it('隔离界面上下文，重启恢复草稿和记录', async () => {
		await Promise.all([
			f.service.saveSession(f.first.id, { draft: '副本 A 的草稿', selected: ['README.md'], currentPath: 'README.md', filter: 'modified' }),
			f.service.saveSession(f.second.id, { draft: '副本 B 的草稿', view: 'history', historyTarget: 'other.txt' }),
		]);
		const restored = new SvnService(new Store(f.store.directory), new Runner());
		await restored.initialize();
		expect(restored.store.get().sessions[f.first.id].draft).toBe('副本 A 的草稿');
		expect(restored.store.get().sessions[f.second.id].draft).toBe('副本 B 的草稿');
		expect(restored.store.get().sessions[f.second.id].historyTarget).toBe('other.txt');
	});
	it('读取文本和属性状态，中文、空格及 @ 路径差异', async () => {
		await writeFile(join(f.a, '目录 空格/中文 @ 文件.txt'), '第一行\n本地的变更\n第三行\n');
		await svn('propset', 'svn:keywords', 'Id', `${f.a}/目录 空格/中文 @ 文件.txt@`);
		const status = await f.service.status(f.first.id);
		const file = status.files.find((file) => file.path === '目录 空格/中文 @ 文件.txt');
		expect(file?.item).toBe('modified');
		expect(file?.props).toBe('modified');
		const diff = await f.service.diff(f.first.id, '目录 空格/中文 @ 文件.txt');
		expect(diff.text).toContain('+本地的变更');
		expect(diff.text).toContain('svn:keywords');
		expect((await f.service.properties(f.first.id, '目录 空格/中文 @ 文件.txt')).find((prop) => prop.name === 'svn:keywords')?.value).toBe('Id');
		expect((await f.service.status(f.second.id)).files.find((file) => file.path === '目录 空格/中文 @ 文件.txt')?.item).toBe('normal');
	});
	it('选择性提交不会带入未选择的修改，成功后更新与历史可查', async () => {
		await writeFile(join(f.a, 'other.txt'), '未选择的修改\n');
		const review = await f.service.review({ wcId: f.first.id, action: 'commit', paths: ['目录 空格/中文 @ 文件.txt'], message: '提交中文路径与属性' });
		expect(review.paths).toEqual(['目录 空格/中文 @ 文件.txt']);
		const result = await finish(f.service, await f.service.execute(review.id));
		expect(result.state, JSON.stringify(result)).toBe('success');
		expect((await f.service.status(f.first.id)).files.find((file) => file.path === 'other.txt')?.item).toBe('modified');
		const update = await f.service.review({ wcId: f.second.id, action: 'update', paths: [] });
		expect((await finish(f.service, await f.service.execute(update.id))).state).toBe('success');
		expect(await readFile(join(f.b, '目录 空格/中文 @ 文件.txt'), 'utf8')).toContain('本地的变更');
		const logs = await f.service.log(f.second.id);
		expect(logs[0].message).toBe('提交中文路径与属性');
		expect((await f.service.diff(f.second.id, '.', logs[0].revision)).text).toContain('svn:keywords');
		expect((await f.service.log(f.second.id, '.', logs[0].revision - 1))[0].revision).toBeLessThan(logs[0].revision);
	});
	it('审阅后即使 SVN 状态相同，内容变化也会拒绝提交并保留草稿', async () => {
		await f.service.saveSession(f.first.id, { draft: '保留失败草稿', selected: ['other.txt'] });
		const review = await f.service.review({ wcId: f.first.id, action: 'commit', paths: ['other.txt'], message: '保留失败草稿' });
		await writeFile(join(f.a, 'other.txt'), '审阅后的另一份内容\n');
		const result = await finish(f.service, await f.service.execute(review.id));
		expect(result.state).toBe('failed');
		expect(result.error?.kind).toBe('stale');
		expect(f.store.get().sessions[f.first.id].draft).toBe('保留失败草稿');
		expect(f.store.get().sessions[f.first.id].selected).toEqual(['other.txt']);
	});
	it('加入新目录时显式列出父目录与实际提交范围', async () => {
		await mkdir(join(f.a, '新增目录'));
		await writeFile(join(f.a, '新增目录/甲.txt'), '甲\n');
		await writeFile(join(f.a, '新增目录/乙.txt'), '乙\n');
		const add = await f.service.review({ wcId: f.first.id, action: 'add', paths: ['新增目录'] });
		expect((await finish(f.service, await f.service.execute(add.id))).state).toBe('success');
		const review = await f.service.review({ wcId: f.first.id, action: 'commit', paths: ['新增目录/甲.txt'], message: '新增目录及显式关联范围' });
		expect(review.paths).toContain('新增目录');
		expect(review.paths).toContain('新增目录/乙.txt');
		expect(review.reasons.length).toBeGreaterThan(0);
		expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
	});
	it('重命名保持历史，提交审阅包含移动两端；删除与还原均可执行', async () => {
		const move = await f.service.review({ wcId: f.first.id, action: 'rename', paths: ['README.md'], destination: '说明 @ 新.md' });
		const result = await finish(f.service, await f.service.execute(move.id));
		expect(result.state, JSON.stringify(result)).toBe('success');
		const review = await f.service.review({ wcId: f.first.id, action: 'commit', paths: ['说明 @ 新.md'], message: '重命名说明' });
		expect(review.paths).toContain('README.md');
		expect(review.paths).toContain('说明 @ 新.md');
		expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
		const del = await f.service.review({ wcId: f.first.id, action: 'delete', paths: ['说明 @ 新.md'] });
		expect(del.warning).toContain('永久丢失');
		expect((await finish(f.service, await f.service.execute(del.id))).state).toBe('success');
		const revert = await f.service.review({ wcId: f.first.id, action: 'revert', paths: ['说明 @ 新.md'] });
		expect((await finish(f.service, await f.service.execute(revert.id))).state).toBe('success');
		expect(await readFile(join(f.a, '说明 @ 新.md'), 'utf8')).toContain('仓盒');
	});
	it('忽略未受控文件是父目录属性变更，列表能够读取忽略状态', async () => {
		await writeFile(join(f.a, '本机缓存.tmp'), 'cache');
		const review = await f.service.review({ wcId: f.first.id, action: 'ignore', paths: ['本机缓存.tmp'] });
		expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
		expect((await f.service.status(f.first.id)).files.find((file) => file.path === '本机缓存.tmp')?.item).toBe('ignored');
	});
	it('根目录还原明确审阅全部影响，撤销忽略属性且保留未受控文件', async () => {
		const review = await f.service.review({ wcId: f.first.id, action: 'revert', paths: ['.'] });
		expect(review.paths).toContain('other.txt');
		expect(review.warning?.trim()).toBeTruthy();
		const result = await finish(f.service, await f.service.execute(review.id));
		expect(result.state, JSON.stringify(result)).toBe('success');
		expect((await f.service.status(f.first.id)).files.find((file) => file.path === '本机缓存.tmp')?.item).toBe('unversioned');
		expect(await readFile(join(f.a, '本机缓存.tmp'), 'utf8')).toBe('cache');
	});
	it('真实更新产生文本冲突，详情可读，解决入口需明确审阅', async () => {
		await writeFile(join(f.b, '目录 空格/中文 @ 文件.txt'), '第一行\n副本 B 冲突修改\n第三行\n');
		await writeFile(join(f.a, '目录 空格/中文 @ 文件.txt'), '第一行\n服务器新修改\n第三行\n');
		const commit = await f.service.review({ wcId: f.first.id, action: 'commit', paths: ['目录 空格/中文 @ 文件.txt'], message: '制造独立测试冲突' });
		expect((await finish(f.service, await f.service.execute(commit.id))).state).toBe('success');
		const update = await f.service.review({ wcId: f.second.id, action: 'update', paths: [] });
		expect((await finish(f.service, await f.service.execute(update.id))).state).toBe('success');
		expect((await f.service.status(f.second.id)).files.find((file) => file.path === '目录 空格/中文 @ 文件.txt')?.item).toBe('conflicted');
		expect((await f.service.info(f.second.id, '目录 空格/中文 @ 文件.txt')).conflicts.length).toBeGreaterThan(0);
		await writeFile(join(f.b, '目录 空格/中文 @ 文件.txt'), '第一行\n人工确认的合并内容\n第三行\n');
		const resolve = await f.service.review({ wcId: f.second.id, action: 'resolve', paths: ['目录 空格/中文 @ 文件.txt'] });
		expect(resolve.warning).toContain('不会自动合并');
		expect((await finish(f.service, await f.service.execute(resolve.id))).state).toBe('success');
	});
	it('远端分层浏览与真实检出，不覆盖已有磁盘目录', async () => {
		const repo = f.store.get().repositories[0];
		expect((await f.service.list(repo.rootUrl, repo.id)).map((entry) => entry.name)).toContain('trunk');
		const result = await finish(
			f.service,
			await f.service.checkout({ url: `${f.url}/trunk`, destination: join(f.root, '新检出 @'), repositoryId: repo.id, depth: 'infinity' }),
		);
		expect(result.state, JSON.stringify(result)).toBe('success');
		expect(f.store.get().workingCopies).toHaveLength(3);
		await expect(f.service.checkout({ url: `${f.url}/trunk`, destination: f.a, depth: 'infinity' })).rejects.toThrow('尚不存在');
	});
	it('阻止目录穿越、.svn 内部写入、超出仓库边界的浏览', async () => {
		await expect(f.service.info(f.first.id, '../other')).rejects.toThrow('允许范围');
		await expect(f.service.log(f.first.id, '../other')).rejects.toThrow('允许范围');
		await expect(f.service.diff(f.first.id, '../other', 1)).rejects.toThrow('允许范围');
		await expect(f.service.review({ wcId: f.first.id, action: 'delete', paths: ['.svn/wc.db'] })).rejects.toThrow('允许范围');
		await expect(f.service.list('file:///etc', f.store.get().repositories[0].id)).rejects.toThrow('超出');
	});
	it('同一副本写入串行；取消等待操作不伪装回滚', async () => {
		const r1 = await f.service.review({ wcId: f.first.id, action: 'update', paths: [] });
		const r2 = await f.service.review({ wcId: f.first.id, action: 'update', paths: [] });
		const first = await f.service.execute(r1.id);
		const second = await f.service.execute(r2.id);
		f.service.cancel(second.id);
		expect((await finish(f.service, first)).state).toBe('success');
		const cancelled = await finish(f.service, second);
		expect(cancelled.state).toBe('cancelled');
	});
	it('认证/证书/锁/网络错误分型，命令失败可读', async () => {
		expect(classify('svn: E170001: Authentication failed').kind).toBe('auth');
		expect(classify('svn: E230001: Server SSL certificate verification failed').kind).toBe('certificate');
		expect(classify('svn: E155004: Working copy locked').kind).toBe('locked');
		expect(classify('svn: E170013: Unable to connect to a repository').kind).toBe('network');
		await expect(f.service.info(f.first.id, '不存在.txt')).rejects.toThrow();
	});
});
