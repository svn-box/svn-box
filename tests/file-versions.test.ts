import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFile, writeFile, rm, symlink, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, finish, svn } from './fixtures';
import { FileBackups } from '../src/main/file-content';
import { SvnService, type MergeInputs } from '../src/main/service';
import { SvnError } from '../src/main/runner';
let f: Awaited<ReturnType<typeof fixture>>;
let launched: MergeInputs | undefined;
let launchFailure: false | 'cancelled' | 'path' = false;

beforeAll(async () => {
	f = await fixture();
	f.service = new SvnService(
		f.store,
		f.runner,
		() => {},
		undefined,
		async (inputs, signal) => {
			if (launchFailure || signal.aborted) {
				throw new SvnError({ kind: launchFailure || 'cancelled', message: 'External merge unavailable or cancelled' });
			}
			launched = inputs;
		},
	);
	await f.service.initialize();
}, 30000);

afterAll(async () => {
	await f?.service.flush();
	f?.runner.shutdown();
	if (f) {
		await rm(f.root, { recursive: true, force: true });
	}
});

async function execute(input: Parameters<SvnService['review']>[0]) {
	const review = await f.service.review(input);
	return finish(f.service, await f.service.execute(review.id));
}

it('恢复历史内容保留当前基线与属性、备份未提交修改，备份重启后仍能恢复', async () => {
	const path = '目录 空格/中文 @ 文件.txt';
	const initial = await readFile(join(f.a, path));
	const revision = Number((await f.service.info(f.first.id, path)).revision);
	await writeFile(join(f.a, path), '第二个已提交版本\n');
	await svn('commit', `${f.a}/${path}@`, '-m', 'second');
	const baseline = (await f.service.info(f.first.id, path)).revision;
	await svn('propset', 'test:preserve', 'current-property', `${f.a}/${path}@`);
	await writeFile(join(f.a, path), '需要备份的未提交内容\n');
	const review = await f.service.review({ wcId: f.first.id, action: 'recover', paths: [path], revision });
	expect(review.preview?.text).toContain('需要备份');
	expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
	expect(await readFile(join(f.a, path))).toEqual(initial);
	expect((await f.service.info(f.first.id, path)).revision).toBe(baseline);
	expect((await f.service.properties(f.first.id, path)).find((p) => p.name === 'test:preserve')?.value).toBe('current-property');
	expect((await f.service.status(f.first.id)).files.find((entry) => entry.path === path)?.item).toBe('modified');
	const restored = new FileBackups(f.store.directory);
	const backup = (await restored.list(f.first.id, path))[0];
	expect((await restored.content(f.first.id, path, backup.id)).toString()).toBe('需要备份的未提交内容\n');
	expect((await execute({ wcId: f.first.id, action: 'restore-backup', paths: [path], backupId: backup.id })).state).toBe('success');
	expect(await readFile(join(f.a, path), 'utf8')).toBe('需要备份的未提交内容\n');
	await expect(f.service.review({ wcId: f.second.id, action: 'restore-backup', paths: [path], backupId: backup.id })).rejects.toThrow();
}, 30000);

it('确认过期、重复执行、目录、符号链接和越界目标不能覆盖文件', async () => {
	const path = 'README.md';
	const review = await f.service.review({ wcId: f.first.id, action: 'recover', paths: [path], revision: 2 });
	await writeFile(join(f.a, path), '确认后又修改\n');
	const operation = await finish(f.service, await f.service.execute(review.id));
	expect(operation.error?.kind).toBe('stale');
	expect(await readFile(join(f.a, path), 'utf8')).toBe('确认后又修改\n');
	await expect(f.service.execute(review.id)).rejects.toThrow();
	await expect(f.service.review({ wcId: f.first.id, action: 'recover', paths: ['目录 空格'], revision: 2 })).rejects.toThrow();
	await expect(f.service.review({ wcId: f.first.id, action: 'recover', paths: ['../README.md'], revision: 2 })).rejects.toThrow();
	await symlink(join(f.a, path), join(f.a, 'link'));
	await expect(f.service.review({ wcId: f.first.id, action: 'recover', paths: ['link'], revision: 2 })).rejects.toThrow();
	await rm(join(f.a, 'link'));
}, 30000);

it('二进制恢复保留原始字节，任意修订比较及历史对工作副本比较读取实际内容', async () => {
	const path = 'binary @.bin';
	const original = Buffer.from([0, 255, 128, 10, 13]);
	await writeFile(join(f.a, path), original);
	await svn('add', `${f.a}/${path}@`);
	await svn('propset', 'svn:mime-type', 'application/octet-stream', `${f.a}/${path}@`);
	await svn('commit', `${f.a}/${path}@`, '-m', 'binary');
	const revision = Number((await f.service.info(f.first.id, path)).revision);
	await writeFile(join(f.a, path), Buffer.from([1, 2, 3]));
	const review = await f.service.review({ wcId: f.first.id, action: 'recover', paths: [path], revision });
	expect(review.preview?.unsupported).toBeTruthy();
	expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
	expect(await readFile(join(f.a, path))).toEqual(original);
	const textPath = '目录 空格/中文 @ 文件.txt';
	const diff = await f.service.rangeDiff({ wcId: f.first.id, path: textPath, from: 2, to: 3 });
	expect(diff.text).toContain('第二个已提交版本');
	const reverse = await f.service.rangeDiff({ wcId: f.first.id, path: textPath, from: 3, to: 2 });
	expect(reverse.text).toContain('-第二个已提交版本');
	const working = await f.service.rangeDiff({ wcId: f.first.id, path: textPath, from: 2, to: 'WORKING' });
	expect(working.text).toContain('需要备份的未提交内容');
	const comparison = await f.service.comparison(f.first.id, textPath, undefined, { from: 2, to: 'WORKING' });
	expect(await readFile(comparison.left, 'utf8')).toContain('共享的内容');
	expect(await readFile(comparison.right, 'utf8')).toBe('需要备份的未提交内容\n');
}, 30000);

async function conflict(path: string) {
	await writeFile(join(f.a, path), 'common base\n');
	await svn('add', `${f.a}/${path}@`);
	await svn('commit', `${f.a}/${path}@`, '-m', 'base');
	await svn('update', `${f.b}@`, '--ignore-externals');
	await writeFile(join(f.a, path), 'incoming contents\n');
	await svn('commit', `${f.a}/${path}@`, '-m', 'incoming');
	await writeFile(join(f.b, path), 'local contents\n');
	await svn('update', `${f.b}@`, '--ignore-externals', '--accept', 'postpone');
	return await readFile(join(f.b, path));
}

it('真实文本冲突保留本地 / 接受传入均需审阅，未提交内容有可恢复备份', async () => {
	for (const action of ['resolve-local', 'resolve-incoming'] as const) {
		const path = `${action} 中文 @.txt`;
		const before = await conflict(path);
		const review = await f.service.review({ wcId: f.second.id, action, paths: [path] });
		expect(review.preview?.text).toContain('contents');
		expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('success');
		expect(await readFile(join(f.b, path), 'utf8')).toBe(action === 'resolve-local' ? 'local contents\n' : 'incoming contents\n');
		expect((await f.service.status(f.second.id)).files.find((entry) => entry.path === path)?.item).not.toBe('conflicted');
		const backup = (await f.service.fileBackups(f.second.id, path))[0];
		expect(await new FileBackups(f.store.directory).content(f.second.id, path, backup.id)).toEqual(before);
	}
}, 30000);

it('三方合并提供真实来源，输出隔离、未保存不可应用、明确应用后才解除冲突', async () => {
	const path = 'merge 中文 @.txt';
	const before = await conflict(path);
	expect((await execute({ wcId: f.second.id, action: 'merge', paths: [path] })).state).toBe('success');
	expect(await readFile(launched!.base, 'utf8')).toBe('common base\n');
	expect(await readFile(launched!.local, 'utf8')).toBe('local contents\n');
	expect(await readFile(launched!.incoming, 'utf8')).toBe('incoming contents\n');
	let state = (await f.service.mergeState(f.second.id, path))!;
	expect(state.hasResult).toBe(false);
	await expect(f.service.review({ wcId: f.second.id, action: 'apply-merge', paths: [path], mergeId: state.id })).rejects.toThrow();
	await writeFile(launched!.output, Buffer.from([0, 255]));
	expect((await f.service.mergeState(f.second.id, path))?.hasResult).toBe(false);
	await expect(f.service.review({ wcId: f.second.id, action: 'apply-merge', paths: [path], mergeId: state.id })).rejects.toThrow();
	await writeFile(launched!.output, 'manually merged\n');
	expect(await readFile(join(f.b, path))).toEqual(before);
	expect((await f.service.status(f.second.id)).files.find((entry) => entry.path === path)?.item).toBe('conflicted');
	state = (await f.service.mergeState(f.second.id, path))!;
	expect(state.hasResult).toBe(true);
	expect(state.markers).toBe(false);
	const review = await f.service.review({ wcId: f.second.id, action: 'apply-merge', paths: [path], mergeId: state.id });
	await writeFile(launched!.output, 'changed after review\n');
	expect((await finish(f.service, await f.service.execute(review.id))).error?.kind).toBe('stale');
	expect(await readFile(join(f.b, path))).toEqual(before);
	expect((await execute({ wcId: f.second.id, action: 'apply-merge', paths: [path], mergeId: state.id })).state).toBe('success');
	expect(await readFile(join(f.b, path), 'utf8')).toBe('changed after review\n');
}, 30000);

it('外部工具取消不改文件；残留标记和冲突来源变化不能误报解决', async () => {
	const path = 'cancel merge.txt';
	const before = await conflict(path);
	launchFailure = 'path';
	expect((await execute({ wcId: f.second.id, action: 'merge', paths: [path] })).error?.kind).toBe('path');
	launchFailure = 'cancelled';
	expect((await execute({ wcId: f.second.id, action: 'merge', paths: [path] })).state).toBe('cancelled');
	launchFailure = false;
	expect(await readFile(join(f.b, path))).toEqual(before);
	await expect(f.service.review({ wcId: f.second.id, action: 'resolve', paths: [path] })).rejects.toThrow();
	const review = await f.service.review({ wcId: f.second.id, action: 'resolve-local', paths: [path] });
	const info = await f.service.info(f.second.id, path);
	const source = info.conflicts.find((entry) => entry.type === 'text')!['prev-wc-file'] as string;
	await writeFile(source, 'changed source\n');
	expect((await finish(f.service, await f.service.execute(review.id))).error?.kind).toBe('stale');
	expect(await readFile(join(f.b, path))).toEqual(before);
}, 30000);

it('只读及 needs-lock 文件在审阅和真正覆盖前均受保护', async () => {
	const path = '只读保护.txt';
	const target = join(f.a, path);
	await writeFile(target, 'protected content\n');
	await svn('add', `${target}@`);
	await svn('propset', 'svn:needs-lock', '*', `${target}@`);
	await svn('commit', `${target}@`, '-m', 'readonly fixture');
	const revision = Number((await f.service.info(f.first.id, path)).revision);
	await chmod(target, 0o444);
	try {
		await expect(f.service.review({ wcId: f.first.id, action: 'recover', paths: [path], revision })).rejects.toMatchObject({ info: { kind: 'path' } });
		await chmod(target, 0o644);
		const review = await f.service.review({ wcId: f.first.id, action: 'recover', paths: [path], revision });
		await chmod(target, 0o444);
		expect((await finish(f.service, await f.service.execute(review.id))).state).toBe('failed');
		expect(await readFile(target, 'utf8')).toBe('protected content\n');
	} finally {
		await chmod(target, 0o644);
	}
}, 30000);

it('中断或损坏的备份和合并元数据不会阻断有效记录与其他项目', async () => {
	const backups = new FileBackups(f.store.directory);
	const path = 'other.txt';
	const saved = await backups.create(f.first.id, path, 'recover', Buffer.from('recoverable backup\n'));
	const directory = join(f.store.directory, 'file-backups');
	await writeFile(join(directory, `${randomUUID()}.json`), '{');
	await writeFile(join(directory, `${randomUUID()}.json`), 'null');
	expect((await f.service.fileBackups(f.first.id, path)).map((item) => item.id)).toContain(saved.id);
	expect((await backups.content(f.first.id, path, saved.id)).toString()).toBe('recoverable backup\n');
	const mergePath = 'metadata merge.txt';
	await conflict(mergePath);
	expect((await execute({ wcId: f.second.id, action: 'merge', paths: [mergePath] })).state).toBe('success');
	const validMerge = await f.service.mergeState(f.second.id, mergePath);
	const merges = join(f.store.directory, 'merges');
	const empty = join(merges, randomUUID());
	await mkdir(empty, { recursive: true });
	const malformed = join(merges, randomUUID());
	await mkdir(malformed);
	await writeFile(join(malformed, 'session.json'), '{');
	await expect(f.service.mergeState(f.first.id, 'README.md')).resolves.toBeNull();
	expect((await f.service.mergeState(f.second.id, mergePath))?.id).toBe(validMerge?.id);
}, 30000);
