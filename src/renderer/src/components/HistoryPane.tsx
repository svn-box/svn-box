import { CircleAlert, History, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import { type WorkingCopy, type WorkspaceSession } from '../../../shared/types';
import { useHistoryEntries } from '../queries/hooks';
import { useSessionSlice, useWorkspaceStore, workspaceStore } from '../state/workspace';
import { errorText } from '../lib/api';
import { Button } from './ui/button';
import { HistoryTimeline } from './HistoryTimeline';

export function HistoryPane({ wc, compareFile }: { wc: WorkingCopy; compareFile: (path: string, revision?: number) => void }) {
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
		<div className="file-pane" tabIndex={-1} aria-label="历史列表">
			<div className="workspace-toolbar history-filter">
				<div className="history-target">
					<History size={13} />
					<span className="truncate" title={session.historyTarget}>
						{session.historyTarget === '.' ? '整个工作副本' : session.historyTarget}
					</span>
					{session.historyTarget !== '.' && (
						<button title="查询整个工作副本" onClick={() => patchSession({ historyTarget: '.' })}>
							<X size={12} />
						</button>
					)}
				</div>
				<div className="inline-search">
					<Search size={12} />
					<input
						aria-label="筛选已加载历史"
						placeholder="筛选已加载记录…"
						value={historySearch}
						onChange={(event) => patchSession({ historySearch: event.target.value })}
					/>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="history-refresh"
					title="重新查询服务器历史"
					aria-label="重新查询服务器历史"
					aria-busy={history.isFetching || undefined}
					disabled={history.isFetching}
					onClick={() => void history.refetch()}
				>
					<RefreshCw className={history.isFetching ? 'spin' : ''} />
					{history.isFetching ? '刷新中' : '刷新'}
				</Button>
			</div>
			{history.error ? (
				<div className="empty error-text">
					<CircleAlert />
					{history.error ? errorText(history.error) : ''}
					<Button variant="outline" onClick={() => void history.refetch()}>
						重试
					</Button>
				</div>
			) : !logs && history.isFetching ? (
				<div className="empty">
					<LoaderCircle className="spin" />
					正在查询服务器历史
				</div>
			) : !filteredLogs.length ? (
				<div className="empty">
					<History size={28} />
					{historySearch ? '已加载记录中没有匹配项' : '此路径尚无历史记录'}
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
				<span>已加载 {logs?.length ?? 0} 条 · 输入框仅筛选已加载记录</span>
				<Button variant="ghost" size="sm" disabled={history.isFetching || !history.hasNextPage || !logs?.length} onClick={() => void history.fetchNextPage()}>
					{history.isFetching && <LoaderCircle className="spin" />}
					{!history.hasNextPage ? '已到历史起点' : '从服务器加载更早记录'}
				</Button>
			</div>
		</div>
	);
}
