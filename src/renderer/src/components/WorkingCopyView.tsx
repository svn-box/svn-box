import { useEffect, type ReactNode } from 'react';
import { CircleAlert, Cloud, Code2, Files, GitBranch, History, MoreHorizontal, Terminal, Wrench } from 'lucide-react';
import { isChanged, type Action, type WorkingCopy, type WorkspaceSession } from '../../../shared/types';
import { useDiff, useStatus } from '../queries/hooks';
import { useSessionSlice, useWorkspaceStore, workspaceStore } from '../state/workspace';
import { api, errorText } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { FilePane, type FileContext } from './FilePane';
import { HistoryPane } from './HistoryPane';
import { DetailsPanel } from './DetailsPanel';
import { DiffView } from './DiffView';
import { fmtDate } from './file-presentation';
import { resizePanel as resize } from '../lib/panel-resize';

export function WorkingCopyView({
	wc,
	previewHidden,
	setPreviewHidden,
	fileActions,
	setContext,
	compareFile,
	refresh,
	requestReview,
	openCommit,
}: {
	wc: WorkingCopy;
	previewHidden: boolean;
	setPreviewHidden: (value: boolean | ((previous: boolean) => boolean)) => void;
	fileActions: (path: string) => ReactNode;
	setContext: (context: FileContext) => void;
	compareFile: (path: string, revision?: number) => void;
	refresh: (id: string, remote?: boolean) => unknown;
	requestReview: (action: Action, paths: string[]) => unknown;
	openCommit: () => void;
}) {
	const session = useSessionSlice(wc.id, ['view', 'lastFileView', 'currentPath']);
	const patchSession = (patch: Partial<WorkspaceSession>) => workspaceStore.getState().patchSession(patch, wc.id);
	const showDetails = useWorkspaceStore((store) => store.showDetails);
	const listHeight = useWorkspaceStore((store) => store.listHeight);
	const status = useStatus(wc.id);
	const snapshot = status.data;
	const currentError = status.error ? errorText(status.error) : '';
	const currentFile = snapshot?.files.find((file) => file.path === session.currentPath);
	const showPreview =
		session.view !== 'history' &&
		!previewHidden &&
		!!currentFile &&
		(isChanged(currentFile) ||
			(currentFile.kind === 'dir' && snapshot?.files.some((file) => isChanged(file) && (currentFile.path === '.' || file.path.startsWith(`${currentFile.path}/`)))));
	const showError = notifyError;
	useEffect(() => {
		setPreviewHidden(false);
	}, [wc.id, session.currentPath, session.view]);
	return (
		<>
			<div className="tabs-bar">
				<div className="view-tabs" role="tablist" aria-label="工作区视图">
					<button
						role="tab"
						aria-selected={session.view !== 'history'}
						className={session.view !== 'history' ? 'active' : ''}
						onClick={() => patchSession({ view: session.lastFileView ?? 'changes' })}
					>
						<Files size={14} />
						文件
					</button>
					<button
						role="tab"
						aria-selected={session.view === 'history'}
						className={session.view === 'history' ? 'active' : ''}
						onClick={() => patchSession({ view: 'history' })}
					>
						<History size={14} />
						历史
					</button>
				</div>
				<div className="workspace-context">
					<span title={wc.url}>
						<GitBranch size={12} />
						{decodeURIComponent(wc.url.split('/').at(-1) || '/')}
					</span>
					<span className="scan-time" title={fmtDate(snapshot?.scannedAt || wc.lastScan)}>
						<span className={`local-dot ${currentError ? 'bad' : ''}`} />
						{status.isFetching ? '正在扫描…' : `本地扫描 ${snapshot ? new Date(snapshot.scannedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未扫描'}`}
					</span>
				</div>
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
						<DropdownMenuItem
							icon={<History />}
							onSelect={() => {
								patchSession({ view: 'history', historyTarget: '.' });
							}}
						>
							查询整个工作副本历史
						</DropdownMenuItem>
						<DropdownMenuItem
							icon={<Terminal />}
							onSelect={() => {
								void api.call('system', { wcId: wc.id, path: '.', action: 'terminal' }).catch(showError);
							}}
						>
							打开终端
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem icon={<Wrench />} onSelect={() => void requestReview('cleanup', [])}>
							清理工作副本锁…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{currentError && (
				<div className="workspace-error">
					<CircleAlert size={16} />
					<span>{currentError}</span>
					<Button variant="outline" size="sm" onClick={() => void refresh(wc.id)}>
						重试
					</Button>
				</div>
			)}
			<div className="content-columns">
				<div className={`work-content ${showPreview ? 'with-preview' : 'without-preview'}`}>
					{session.view === 'history' ? (
						<HistoryPane wc={wc} compareFile={compareFile} />
					) : (
						<FilePane
							wc={wc}
							height={showPreview ? listHeight : undefined}
							fileActions={fileActions}
							setContext={setContext}
							compareFile={compareFile}
							onTogglePreview={() => setPreviewHidden((value) => !value)}
						/>
					)}
					{showPreview && (
						<>
							{' '}
							<div
								className="horizontal-resizer"
								role="separator"
								aria-label="调整文件与差异高度"
								aria-orientation="horizontal"
								onPointerDown={(event) => resize(event, 'list')}
							/>
							<FileComparison wc={wc} path={session.currentPath} scan={snapshot?.scannedAt} onClose={() => setPreviewHidden(true)} compareFile={compareFile} />
						</>
					)}
					{session.view !== 'history' && <DraftBar wcId={wc.id} openCommit={openCommit} />}
				</div>
				{showDetails && (
					<>
						<div className="resizer" role="separator" aria-label="调整详情宽度" aria-orientation="vertical" onPointerDown={(event) => resize(event, 'details')} />
						<DetailsPanel wc={wc} requestReview={requestReview} refresh={refresh} />{' '}
					</>
				)}
			</div>
		</>
	);
}

function FileComparison({ wc, path, scan, onClose, compareFile }: { wc: WorkingCopy; path: string; scan?: string; onClose: () => void; compareFile: (path: string) => void }) {
	const diff = useDiff(wc.id, path, scan);
	const file = useStatus(wc.id).data?.files.find((entry) => entry.path === path);
	return <DiffView {...diff} onClose={onClose} onCompare={file?.kind === 'file' ? () => compareFile(path) : undefined} title={path || '差异预览'} />;
}

function DraftBar({ wcId, openCommit }: { wcId: string; openCommit: () => void }) {
	const draft = useWorkspaceStore((state) => state.sessions[wcId]?.draft ?? '');
	if (!draft) {
		return null;
	}
	return (
		<div className="draft-bar">
			<div>
				<span className="draft-icon">
					<Code2 size={15} />
				</span>
				<strong>提交草稿</strong>
				<span className="draft-preview">{draft.split('\n')[0]}</span>
			</div>
			<Button variant="ghost" size="sm" onClick={openCommit}>
				继续编辑<kbd>⌘↵</kbd>
			</Button>
		</div>
	);
}
