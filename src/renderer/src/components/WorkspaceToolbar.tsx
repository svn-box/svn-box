import { Cloud, Files, GitBranch, History, MoreHorizontal, Terminal, Wrench } from 'lucide-react';
import type { Action, WorkingCopy } from '../../../shared/types';
import { api, errorText } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { useStatus } from '../queries/hooks';
import { useSessionSlice, workspaceStore } from '../state/workspace';
import { fmtDate } from './file-presentation';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

export function WorkspaceViewTabs({ wcId }: { wcId: string }) {
	const session = useSessionSlice(wcId, ['view', 'lastFileView']);
	return (
		<div
			className="view-tabs segmented-control"
			role="tablist"
			aria-label="工作区视图"
			onKeyDown={(event) => {
				if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) {
					return;
				}
				event.preventDefault();
				const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
				const index = buttons.indexOf(event.target as HTMLButtonElement);
				const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 2) % 2;
				buttons[next]?.click();
				buttons[next]?.focus();
			}}
		>
			<Button
				role="tab"
				variant="ghost"
				size="sm"
				aria-selected={session.view !== 'history'}
				tabIndex={session.view !== 'history' ? 0 : -1}
				onClick={() => workspaceStore.getState().patchSession({ view: session.lastFileView ?? 'changes' }, wcId)}
			>
				<Files />
				文件
			</Button>
			<Button
				role="tab"
				variant="ghost"
				size="sm"
				aria-selected={session.view === 'history'}
				tabIndex={session.view === 'history' ? 0 : -1}
				onClick={() => workspaceStore.getState().patchSession({ view: 'history' }, wcId)}
			>
				<History />
				历史
			</Button>
		</div>
	);
}

export function WorkingCopyMenu({
	wc,
	refresh,
	requestReview,
}: {
	wc: WorkingCopy;
	refresh: (id: string, remote?: boolean) => unknown;
	requestReview: (action: Action, paths: string[]) => unknown;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" aria-label="工作副本操作">
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem icon={<Cloud />} onSelect={() => void refresh(wc.id, true)}>
					检查远端变化（不更新）
				</DropdownMenuItem>
				<DropdownMenuItem icon={<History />} onSelect={() => workspaceStore.getState().patchSession({ view: 'history', historyTarget: '.' }, wc.id)}>
					查询整个工作副本历史
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					icon={<Terminal />}
					onSelect={() => {
						void api.call('system', { wcId: wc.id, path: '.', action: 'terminal' }).catch(notifyError);
					}}
				>
					打开终端
				</DropdownMenuItem>
				<DropdownMenuItem icon={<Wrench />} onSelect={() => void requestReview('cleanup', [])}>
					清理工作副本锁…
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function WorkspaceStatus({ wc }: { wc: WorkingCopy }) {
	const status = useStatus(wc.id);
	const snapshot = status.data;
	return (
		<div className="workspace-context">
			<span className="branch-location" title={wc.url}>
				<GitBranch size={12} />
				{decodeURIComponent(wc.url.split('/').at(-1) || '/')}
			</span>
			<span className="scan-time" title={status.error ? errorText(status.error) : fmtDate(snapshot?.scannedAt ?? wc.lastScan)}>
				<span className={`local-dot ${status.error ? 'bad' : ''}`} />
				{status.isFetching
					? '正在扫描…'
					: status.error
						? '本地扫描失败'
						: `本地扫描 ${snapshot ? new Date(snapshot.scannedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未扫描'}`}
			</span>
		</div>
	);
}
