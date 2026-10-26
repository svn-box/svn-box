import { useTranslation } from 'react-i18next';
import { Fragment } from 'react';
import { CircleAlert, Folder, History, Info, LoaderCircle, X } from 'lucide-react';
import { isConflict, type Action, type WorkingCopy, type WorkspaceSession } from '../../../shared/types';
import { useFileInfo, useHistoryEntries, useStatus } from '../queries/hooks';
import { useSessionSlice, useWorkspaceStore, workspaceStore } from '../state/workspace';
import { api } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { Button } from './ui/button';
import { FileIcon } from './FileIcon';
import { fmtDate, leaf, StatusBadge } from './file-presentation';

export function DetailsPanel({ wc, requestReview, refresh }: { wc: WorkingCopy; requestReview: (action: Action, paths: string[]) => unknown; refresh: (id: string) => unknown }) {
	const { t } = useTranslation();
	const session = useSessionSlice(wc.id, ['view']);
	const detailsWidth = useWorkspaceStore((state) => state.detailsWidth);

	const setShowDetails = (value: boolean) => workspaceStore.getState().setPanel('showDetails', value);

	return (
		<aside className="details-panel" style={{ width: detailsWidth }}>
			<div className="details-title">
				<Info size={13} />
				{session.view === 'history' ? t('detailsPanel.commitDetails') : t('detailsPanel.fileDetails')}
				<button aria-label={t('detailsPanel.collapseInspector')} onClick={() => setShowDetails(false)}>
					<X size={13} />
				</button>
			</div>
			{session.view === 'history' ? <HistoryDetails wcId={wc.id} /> : <FileDetails wc={wc} requestReview={requestReview} refresh={refresh} />}
		</aside>
	);
}

function HistoryDetails({ wcId }: { wcId: string }) {
	const { t } = useTranslation();
	const session = useSessionSlice(wcId, ['historyTarget', 'historySearch', 'historyRevision']);
	const { filteredLogs } = useHistoryEntries(wcId, session.historyTarget, session.historySearch ?? '');
	const selectedLog = filteredLogs.find((entry) => entry.revision === session.historyRevision);
	if (!selectedLog) {
		return <DetailsEmpty history />;
	}
	return (
		<>
			<div className="detail-identity">
				<div className="detail-file-icon">
					<History size={27} />
				</div>
				<h2>
					{t('detailsPanel.revisionR', {
						revision: selectedLog.revision,
					})}
				</h2>
				<p className="detail-subtitle">{selectedLog.author || t('detailsPanel.unknownAuthor')}</p>
			</div>
			<dl>
				<dt>{t('detailsPanel.commitDate')}</dt>
				<dd>{fmtDate(selectedLog.date)}</dd>
			</dl>
			<div className="detail-section-title">{t('commitPanel.commitMessage')}</div>
			<pre className="commit-message">{selectedLog.message || t('detailsPanel.noCommitMessage')}</pre>
			<div className="detail-section-title">{t('detailsPanel.changedScope')}</div>
			<dl>
				<dt>{t('detailsPanel.allPaths')}</dt>
				<dd>{selectedLog.paths.length}</dd>
				{[
					['A', t('common.added')],
					['M', t('common.modified')],
					['D', t('common.deleted')],
					['R', t('common.replaced')],
				].map(([action, label]) => (
					<Fragment key={action}>
						<dt>{label}</dt>
						<dd>{selectedLog.paths.filter((path) => path.action === action).length}</dd>
					</Fragment>
				))}
			</dl>
		</>
	);
}

function FileDetails({ wc, requestReview, refresh }: { wc: WorkingCopy; requestReview: (action: Action, paths: string[]) => unknown; refresh: (id: string) => unknown }) {
	const { t } = useTranslation();
	const session = useSessionSlice(wc.id, ['currentPath']);

	const patchSession = (patch: Partial<WorkspaceSession>) => workspaceStore.getState().patchSession(patch, wc.id);

	const showError = notifyError;
	const snapshot = useStatus(wc.id).data;
	const currentFile = snapshot?.files.find((file) => file.path === session.currentPath);
	const fileInfo = useFileInfo(wc.id, session.currentPath, snapshot?.scannedAt);
	if (!session.currentPath) {
		return <DetailsEmpty />;
	}
	return (
		<>
			<div className="detail-identity">
				<div className="detail-file-icon">
					<FileIcon path={session.currentPath} kind={currentFile?.kind} size={40} />
				</div>
				<h2>{session.currentPath === '.' ? wc.name : leaf(session.currentPath)}</h2>
				<p className="detail-subtitle">{currentFile ? <StatusBadge file={currentFile} /> : t('detailsPanel.refreshStatusFirst')}</p>
			</div>
			<div className="detail-section-title">{t('detailsPanel.fileInformation')}</div>
			{fileInfo.loading && (
				<div className="details-loading">
					<LoaderCircle className="spin" size={13} />
					{t('detailsPanel.readingSvnInformation')}
				</div>
			)}
			<dl>
				<dt>{t('detailsPanel.relativePath')}</dt>
				<dd className="break-all">{session.currentPath}</dd>
				<dt>{t('detailsPanel.revision')}</dt>
				<dd className="mono">{fileInfo.info?.revision ? `r${fileInfo.info.revision}` : currentFile?.revision || '—'}</dd>
				<dt>{t('detailsPanel.lastAuthor')}</dt>
				<dd>{currentFile?.author || '—'}</dd>
				<dt>{t('detailsPanel.lastModified')}</dt>
				<dd>{fmtDate(currentFile?.date)}</dd>
				<dt>{t('detailsPanel.fileType')}</dt>
				<dd>{currentFile?.kind === 'dir' ? t('detailsPanel.directory') : currentFile?.kind === 'symlink' ? t('detailsPanel.symbolicLink') : t('common.file')}</dd>
				{currentFile?.movedFrom && (
					<>
						<dt>{t('detailsPanel.movedFrom')}</dt>
						<dd>{currentFile.movedFrom}</dd>
					</>
				)}
				{currentFile?.movedTo && (
					<>
						<dt>{t('detailsPanel.movedTo')}</dt>
						<dd>{currentFile.movedTo}</dd>
					</>
				)}
			</dl>
			{fileInfo.info?.url && (
				<details className="detail-repository">
					<summary>{t('detailsPanel.repositoryUrl')}</summary>
					<p className="break-all">{fileInfo.info.url}</p>
				</details>
			)}
			{currentFile && isConflict(currentFile) && (
				<div className="conflict-box">
					<strong>
						<CircleAlert size={14} />
						{t('detailsPanel.conflictsNeedAttention')}
					</strong>
					<p>
						{currentFile.treeConflicted
							? t('detailsPanel.treeConflictVerifyDeletionsMovesAndTheUpstream')
							: currentFile.props === 'conflicted'
								? t('detailsPanel.propertyConflictInspectAndManuallyCorrectTheConflicting')
								: t('detailsPanel.textConflictMergeAndSaveTheFileIn')}
					</p>
					{fileInfo.info?.conflicts.length ? <pre>{JSON.stringify(fileInfo.info.conflicts, null, 2)}</pre> : null}
					<Button
						variant="outline"
						size="sm"
						onClick={() => {
							void api.call('system', { wcId: wc.id, path: session.currentPath, action: 'merge' }).catch(showError);
						}}
					>
						{t('detailsPanel.openMergeTool')}
					</Button>
					<Button variant="outline" size="sm" onClick={() => void refresh(wc.id)}>
						{t('workspace.checkResolution')}
					</Button>
					<Button size="sm" variant="outline" onClick={() => void requestReview('resolve', [session.currentPath])}>
						{t('detailsPanel.markResolved')}
					</Button>
				</div>
			)}
			<div className="detail-section-title">
				{t('detailsPanel.svnProperties')}
				<span>{fileInfo.properties?.length ?? '—'}</span>
			</div>
			{fileInfo.properties?.length ? (
				fileInfo.properties.map((property) => (
					<div className="property" key={property.name}>
						<code>{property.name}</code>
						<pre>{property.value}</pre>
					</div>
				))
			) : (
				<p className="detail-empty">
					{fileInfo.loading
						? t('detailsPanel.reading')
						: fileInfo.error
							? t('detailsPanel.noSvnPropertiesAreAvailableForThisPath')
							: t('detailsPanel.noCustomPropertiesSet')}
				</p>
			)}
			{fileInfo.error && (
				<details className="detail-error">
					<summary>{t('detailsPanel.viewReadDetails')}</summary>
					<pre>{fileInfo.error}</pre>
				</details>
			)}
			<div className="detail-bottom-actions">
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						void api.call('system', { wcId: wc.id, path: session.currentPath, action: 'reveal' }).catch(showError);
					}}
				>
					<Folder />
					{t('workspace.revealInFinder')}
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() =>
						patchSession({
							view: 'history',
							historyTarget: session.currentPath,
							historyDiffPath: session.currentPath,
							historyRevision: undefined,
						})
					}
				>
					<History />
					{t('detailsPanel.showHistory')}
				</Button>
			</div>
		</>
	);
}

function DetailsEmpty({ history = false }: { history?: boolean }) {
	const { t } = useTranslation();
	return (
		<div className="details-empty">
			<Info size={27} />
			<strong>{history ? t('detailsPanel.noCommitSelected') : t('detailsPanel.noFileSelected')}</strong>
			<p>
				{t('detailsPanel.selectToSee', {
					value: history ? t('detailsPanel.aCommit') : t('detailsPanel.aFileOrDirectory'),
					value2: history ? t('detailsPanel.itsMessageAndChangedPaths') : t('detailsPanel.itsStatusRevisionAndSvnProperties'),
				})}
			</p>
		</div>
	);
}
