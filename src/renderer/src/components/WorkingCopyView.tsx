import { useEffect, type ReactNode } from 'react';
import { CircleAlert, Code2 } from 'lucide-react';
import { isChanged, type Action, type WorkingCopy } from '../../../shared/types';
import { useDiff, useStatus } from '../queries/hooks';
import { useSessionSlice, useWorkspaceStore } from '../state/workspace';
import { errorText } from '../lib/api';

import { Button } from './ui/button';

import { FilePane, type FileContext } from './FilePane';
import { HistoryPane } from './HistoryPane';
import { DetailsPanel } from './DetailsPanel';
import { DiffView } from './DiffView';

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
	const session = useSessionSlice(wc.id, ['view', 'currentPath']);
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
	useEffect(() => {
		setPreviewHidden(false);
	}, [wc.id, session.currentPath, session.view]);
	return (
		<>
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
