import type { LogEntry } from '../../../shared/types';

export interface HistoryDay {
	key: string;
	label: string;
	entries: LogEntry[];
	pathCount: number;
}

export function groupHistory(entries: LogEntry[]): HistoryDay[] {
	const days = new Map<string, HistoryDay>();
	for (const entry of entries) {
		const date = new Date(entry.date);
		const valid = Number.isFinite(date.getTime());
		const key = valid ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : 'unknown';
		let day = days.get(key);
		if (!day) {
			day = {
				key,
				label: valid ? date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }) : '日期未知',
				entries: [],
				pathCount: 0,
			};
			days.set(key, day);
		}
		day.entries.push(entry);
		day.pathCount += entry.paths.length;
	}
	return [...days.values()];
}

export function historyRelativePath(path: string, workingCopyUrl: string, repositoryRoot: string): string | undefined {
	const copy = new URL(workingCopyUrl);
	const root = new URL(repositoryRoot);
	const rootPath = decodeURIComponent(root.pathname).replace(/\/$/, '');
	const copyPath = decodeURIComponent(copy.pathname).replace(/\/$/, '');
	if (copy.protocol !== root.protocol || copy.host !== root.host || (copyPath !== rootPath && !copyPath.startsWith(`${rootPath}/`))) {
		return;
	}
	const prefix = copyPath.slice(rootPath.length);
	if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) {
		return;
	}
	return path.slice(prefix.length).replace(/^\//, '') || '.';
}
