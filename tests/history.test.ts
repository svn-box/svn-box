import { describe, expect, it } from 'vitest';
import { groupHistory, historyRelativePath } from '../src/renderer/src/lib/history';
import { schemas } from '../src/shared/validation';
import type { LogEntry } from '../src/shared/types';

const entry = (revision: number, date: string): LogEntry => ({
	revision,
	date,
	author: '开发者',
	message: '说明',
	paths: [{ path: '/trunk/中文 @ 文件.ts', action: 'M', kind: 'file' }],
});

describe('历史时间线边界', () => {
	it('分页追加的同一天只分组一次，并保留 SVN 的版本顺序', () => {
		const days = groupHistory([entry(6, '2026-10-24T13:00:00Z'), entry(5, '2026-10-23T12:00:00Z'), entry(4, '2026-10-23T11:00:00Z')]);
		expect(days).toHaveLength(2);
		expect(days[1].entries.map((value) => value.revision)).toEqual([5, 4]);
		expect(days[1].pathCount).toBe(2);
	});

	it('按本地日期归组，缺失日期仍可展开', () => {
		const date = '2026-10-23T23:30:00Z';
		const local = new Date(date);
		expect(groupHistory([entry(3, date)])[0].key).toBe(`${local.getFullYear()}-${local.getMonth() + 1}-${local.getDate()}`);
		expect(groupHistory([entry(2, ''), entry(1, 'invalid')])[0].entries).toHaveLength(2);
	});

	it('准确区分工作副本根、子路径与范围外路径，解码中文空格和 @', () => {
		const root = 'svn://user@example.com/repository';
		const copy = `${root}/%E4%B8%AD%E6%96%87%20%40/trunk`;
		expect(historyRelativePath('/中文 @/trunk', copy, root)).toBe('.');
		expect(historyRelativePath('/中文 @/trunk/文件 @.ts', copy, root)).toBe('文件 @.ts');
		expect(historyRelativePath('/中文 @/trunk-other/a.ts', copy, root)).toBeUndefined();
		expect(historyRelativePath('/other/a.ts', copy, root)).toBeUndefined();
		expect(historyRelativePath('/文件.ts', root, root)).toBe('文件.ts');
		expect(historyRelativePath('/trunk/a.ts', 'svn://other.example.com/repository/trunk', root)).toBeUndefined();
	});

	it('IPC 接受历史上下文且拒绝无效版本与过量折叠项', () => {
		const patch = { historySearch: '中文', historyCollapsedDates: ['2026-10-24'], historyCollapsedRevisions: [12], historyPreviewOpen: true };
		expect(schemas.session.parse({ wcId: 'test', patch }).patch).toEqual(patch);
		expect(schemas.session.safeParse({ wcId: 'test', patch: { historyCollapsedRevisions: [-1] } }).success).toBe(false);
		expect(schemas.session.safeParse({ wcId: 'test', patch: { historyCollapsedDates: Array(10001).fill('2026-10-24') } }).success).toBe(false);
	});
});
