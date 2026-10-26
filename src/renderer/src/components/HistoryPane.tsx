import { useTranslation } from 'react-i18next';
import { CircleAlert, History, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { type WorkingCopy, type WorkspaceSession } from '../../../shared/types';
import { useHistoryEntries } from '../queries/hooks';
import { useSessionSlice, useWorkspaceStore, workspaceStore } from '../state/workspace';
import { errorText } from '../lib/api';
import { Button } from './ui/button';
import { HistoryTimeline } from './HistoryTimeline';

export function HistoryPane({ wc, compareFile }: { wc: WorkingCopy; compareFile: (path: string, revision?: number) => void }) {
	const { t } = useTranslation();
	const session = useSessionSlice(wc.id, [
		'historyTarget',
		'historySearch',
		'historyRevision',
		'historyDiffPath',
		'historyCollapsedDates',
		'historyCollapsedRevisions',
		'historyPreviewOpen',
	]);

	const patchSession = (patch: Partial<WorkspaceSession>) => workspaceStore.getState().patchSession(patch, wc.id);

	const repositoryRoot = useWorkspaceStore((state) => state.catalog?.repositories.find((repo) => repo.id === wc.repositoryId)?.rootUrl ?? wc.url);
	const historySearch = session.historySearch ?? '';
	const historyKey = `${wc.id}:${session.historyTarget}`;
	const { history, logs, filteredLogs } = useHistoryEntries(wc.id, session.historyTarget, historySearch);
	return (
		<div className="file-pane" tabIndex={-1} aria-label={t('historyPane.historyList')}>
			<div className="workspace-toolbar history-filter">
				<div className="history-target">
					<History size={13} />
					<span className="truncate" title={session.historyTarget}>
						{session.historyTarget === '.' ? t('historyPane.entireWorkingCopy') : session.historyTarget}
					</span>
					{session.historyTarget !== '.' && (
						<button title={t('historyPane.queryEntireWorkingCopy')} onClick={() => patchSession({ historyTarget: '.' })}>
							<X size={12} />
						</button>
					)}
				</div>
				<div className="inline-search">
					<Search size={12} />
					<input
						aria-label={t('historyPane.filterLoadedHistory')}
						placeholder={t('historyPane.filterLoadedRecords')}
						value={historySearch}
						onChange={(event) => patchSession({ historySearch: event.target.value })}
					/>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="history-refresh"
					title={t('historyPane.queryServerHistoryAgain')}
					aria-label={t('historyPane.queryServerHistoryAgain')}
					aria-busy={history.isFetching || undefined}
					disabled={history.isFetching}
					onClick={() => void history.refetch()}
				>
					<RefreshCw className={history.isFetching ? 'spin' : ''} />
					{history.isFetching ? t('historyPane.refreshing') : t('historyPane.refresh')}
				</Button>
			</div>
			{history.error ? (
				<div className="empty error-text">
					<CircleAlert />
					{history.error ? errorText(history.error) : ''}
					<Button variant="outline" onClick={() => void history.refetch()}>
						{t('historyPane.retry')}
					</Button>
				</div>
			) : !logs && history.isFetching ? (
				<div className="empty">
					<LoaderCircle className="spin" />
					{t('historyPane.queryingServerHistory')}
				</div>
			) : !filteredLogs.length ? (
				<div className="empty">
					<History size={28} />
					{historySearch ? t('historyPane.noMatchesInLoadedRecords') : t('historyPane.noHistoryForThisPath')}
				</div>
			) : (
				<HistoryTimeline
					key={historyKey}
					entries={filteredLogs}
					session={session}
					wcId={wc.id}
					wcUrl={wc.url}
					repositoryRoot={repositoryRoot}
					onChange={patchSession}
					onCompare={(path, revision) => void compareFile(path, revision)}
				/>
			)}
			<div className="list-footer">
				<span>{t('historyPane.loadedRecords', { count: logs?.length ?? 0 })}</span>
				<Button variant="ghost" size="sm" disabled={history.isFetching || !history.hasNextPage || !logs?.length} onClick={() => void history.fetchNextPage()}>
					{history.isFetching && <LoaderCircle className="spin" />}
					{!history.hasNextPage ? t('historyPane.beginningOfHistoryReached') : t('historyPane.loadEarlierRecordsFromServer')}
				</Button>
			</div>
		</div>
	);
}
