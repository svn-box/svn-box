import { formatTime } from '../../../shared/i18n/format';
import { useTranslation } from 'react-i18next';
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
	const { t } = useTranslation();
	const session = useSessionSlice(wcId, ['view', 'lastFileView']);
	return (
		<div
			className="view-tabs segmented-control"
			role="tablist"
			aria-label={t('workspaceToolbar.workspaceView')}
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
				{t('common.files')}
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
				{t('desktop.history')}
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
	const { t } = useTranslation();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon" aria-label={t('workspaceToolbar.workingCopyActions')}>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem icon={<Cloud />} onSelect={() => void refresh(wc.id, true)}>
					{t('workspaceToolbar.checkRemoteChangesNoUpdate')}
				</DropdownMenuItem>
				<DropdownMenuItem icon={<History />} onSelect={() => workspaceStore.getState().patchSession({ view: 'history', historyTarget: '.' }, wc.id)}>
					{t('workspaceToolbar.queryEntireWorkingCopyHistory')}
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					icon={<Terminal />}
					onSelect={() => {
						void api.call('system', { wcId: wc.id, path: '.', action: 'terminal' }).catch(notifyError);
					}}
				>
					{t('workspaceNavigation.openTerminal')}
				</DropdownMenuItem>
				<DropdownMenuItem icon={<Wrench />} onSelect={() => void requestReview('cleanup', [])}>
					{t('workspaceToolbar.cleanUpWorkingCopyLocks')}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function WorkspaceStatus({ wc }: { wc: WorkingCopy }) {
	const { t } = useTranslation();
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
					? t('workspaceToolbar.scanning')
					: status.error
						? t('workspaceToolbar.localScanFailed')
						: t('workspaceToolbar.localScan', {
								value: snapshot
									? formatTime(snapshot.scannedAt, {
											hour12: false,
										})
									: t('workspaceNavigation.notScannedYet'),
							})}
			</span>
		</div>
	);
}
