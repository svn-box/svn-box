import { isConflict, type FileStatus, type Filter, type Operation } from '../../../shared/types';
export const statusLabels: Record<string, string> = {
	normal: '正常',
	modified: '修改',
	added: '新增',
	deleted: '删除',
	missing: '缺失',
	unversioned: '未受控',
	ignored: '忽略',
	conflicted: '冲突',
	replaced: '替换',
	external: '外部副本',
	obstructed: '阻塞',
	incomplete: '不完整',
	none: '—',
};
export const statusCodes: Record<string, string> = {
	normal: '✓',
	modified: 'M',
	added: 'A',
	deleted: 'D',
	missing: '!',
	unversioned: '?',
	ignored: 'I',
	conflicted: 'C',
	replaced: 'R',
	external: 'X',
	obstructed: '~',
	incomplete: '!',
};
export const filters: { value: Filter; label: string }[] = [
	{ value: 'all', label: '全部' },
	{ value: 'modified', label: '修改' },
	{ value: 'added', label: '新增' },
	{ value: 'deleted', label: '删除' },
	{ value: 'unversioned', label: '未受控' },
	{ value: 'ignored', label: '忽略' },
	{ value: 'conflicted', label: '冲突' },
];
export const opLabels: Record<Operation['state'], string> = {
	waiting: '等待中',
	running: '执行中',
	success: '已完成',
	failed: '失败',
	cancelled: '已取消',
	uncertain: '结果待核实',
};
export const fmtDate = (date?: string): string => (date ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '—');

export const leaf = (path: string): string => path.split('/').at(-1) || path;

export const parent = (path: string): string => (path.includes('/') ? path.split('/').slice(0, -1).join('/') : '');

export function fileState(file: FileStatus): string {
	return isConflict(file)
		? 'conflicted'
		: file.copied && ['normal', 'none'].includes(file.item)
			? 'added'
			: file.props === 'modified' && ['normal', 'none'].includes(file.item)
				? 'modified'
				: file.item;
}

export function StatusBadge({ file }: { file: FileStatus }) {
	const status = fileState(file);
	return (
		<span
			className={`status-badge ${status}`}
			title={`${statusLabels[status] || status} · 属性 ${statusLabels[file.props] || file.props}${file.copied ? ' · 带历史复制' : ''}${file.treeConflicted ? ' · 树冲突' : ''}`}
		>
			<b>{statusCodes[status] || '·'}</b>
			{statusLabels[status] || status}
			{file.props === 'modified' && <i>属性</i>}
			{file.copied && <i>复制</i>}
			{file.treeConflicted && <i>树</i>}
			{file.external && <i>外部</i>}
		</span>
	);
}
