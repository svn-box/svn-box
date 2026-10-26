import { formatTime } from '../../../shared/i18n/format';
import { useTranslation } from 'react-i18next';
import { translate } from '../../../shared/i18n';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileDiff } from 'lucide-react';
import type { LogEntry, WorkspaceSession } from '../../../shared/types';
import { HistoryComparison } from './HistoryComparison';
import { groupHistory, historyRelativePath, type HistoryDay } from '../lib/history';
import { Button } from './ui/button';
import { FileIcon } from './FileIcon';
import { ScrollArea } from './ui/scroll-area';
type ChangedPath = LogEntry['paths'][number];
type TimelineRow =
	| { key: string; type: 'day'; day: HistoryDay }
	| { key: string; type: 'commit'; entry: LogEntry }
	| { key: string; type: 'path'; entry: LogEntry; path: ChangedPath }
	| { key: string; type: 'preview'; entry: LogEntry }
	| { key: string; type: 'space'; entry: LogEntry };
const actions: Record<string, string> = {
	get A() {
		return translate('common.added');
	},

	get M() {
		return translate('common.modified');
	},

	get D() {
		return translate('common.deleted');
	},

	get R() {
		return translate('common.replaced');
	},
};
const heights = { day: 32, commit: 54, path: 26, preview: 376, space: 12 };

export function HistoryTimeline({
	entries,
	session,
	wcId,
	wcUrl,
	repositoryRoot,
	onChange,
	onCompare,
	onVersions,
}: {
	entries: LogEntry[];
	session: Pick<
		WorkspaceSession,
		'historyTarget' | 'historySearch' | 'historyRevision' | 'historyDiffPath' | 'historyCollapsedDates' | 'historyCollapsedRevisions' | 'historyPreviewOpen'
	>;
	wcId: string;
	wcUrl: string;
	repositoryRoot: string;
	onChange: (patch: Partial<WorkspaceSession>) => void;
	onCompare: (path: string, revision: number) => void;
	onVersions: (path: string, revision: number) => void;
}) {
	const { t } = useTranslation();
	const viewport = useRef<HTMLDivElement>(null);
	const [activeKey, setActiveKey] = useState('');
	const [scrollRequest, setScrollRequest] = useState(0);
	const pendingScroll = useRef<string | undefined>(undefined);
	const days = useMemo(() => groupHistory(entries), [entries, t]);
	const collapsedDates = useMemo(() => new Set(session.historyCollapsedDates ?? []), [session.historyCollapsedDates]);
	const collapsedRevisions = useMemo(() => new Set(session.historyCollapsedRevisions ?? []), [session.historyCollapsedRevisions]);
	const preview = session.historyPreviewOpen ? entries.find((entry) => entry.revision === session.historyRevision) : undefined;
	const previewVisible = !!preview && !collapsedRevisions.has(preview.revision) && days.some((day) => !collapsedDates.has(day.key) && day.entries.includes(preview));
	const previewPath = session.historyDiffPath ?? session.historyTarget;
	const rows = useMemo(() => {
		const result: TimelineRow[] = [];
		for (const day of days) {
			result.push({ key: `day:${day.key}`, type: 'day', day });
			if (collapsedDates.has(day.key)) {
				continue;
			}
			for (const entry of day.entries) {
				result.push({ key: `commit:${entry.revision}`, type: 'commit', entry });
				if (collapsedRevisions.has(entry.revision)) {
					continue;
				}
				if (previewVisible && preview?.revision === entry.revision) {
					result.push({ key: `preview:${entry.revision}`, type: 'preview', entry });
				}
				entry.paths.forEach((path, index) => result.push({ key: `path:${entry.revision}:${index}`, type: 'path', entry, path }));
				result.push({ key: `space:${entry.revision}`, type: 'space', entry });
			}
		}
		return result;
	}, [days, collapsedDates, collapsedRevisions, previewVisible, preview?.revision]);
	const virtual = useVirtualizer({
		count: rows.length,
		getScrollElement: () => viewport.current,
		estimateSize: (index) => heights[rows[index].type],
		getItemKey: (index) => rows[index].key,
		overscan: 8,
	});
	useEffect(() => {
		virtual.measure();
		if (pendingScroll.current) {
			const index = rows.findIndex((row) => row.key === pendingScroll.current);
			if (index >= 0) {
				virtual.scrollToIndex(index, { align: 'auto' });
			}
			pendingScroll.current = undefined;
		}
	}, [rows, virtual, scrollRequest]);

	function toggleDay(day: HistoryDay) {
		onChange({ historyCollapsedDates: collapsedDates.has(day.key) ? [...collapsedDates].filter((key) => key !== day.key) : [...collapsedDates, day.key] });
	}

	function toggleCommit(entry: LogEntry) {
		onChange({
			historyRevision: entry.revision,
			historyPreviewOpen: session.historyPreviewOpen && session.historyRevision === entry.revision,
			historyCollapsedRevisions: collapsedRevisions.has(entry.revision)
				? [...collapsedRevisions].filter((revision) => revision !== entry.revision)
				: [...collapsedRevisions, entry.revision],
		});
	}

	function openPreview(entry: LogEntry, path = session.historyTarget) {
		pendingScroll.current = `preview:${entry.revision}`;
		setScrollRequest((value) => value + 1);
		onChange({
			historyRevision: entry.revision,
			historyDiffPath: path,
			historyPreviewOpen: true,
			historyCollapsedRevisions: [...collapsedRevisions].filter((revision) => revision !== entry.revision),
		});
	}

	function closePreview(revision: number) {
		const key = `commit:${revision}`;
		pendingScroll.current = key;
		setActiveKey(key);
		setScrollRequest((value) => value + 1);
		viewport.current?.focus();
		onChange({ historyPreviewOpen: false });
	}

	function activate(row: TimelineRow) {
		if (row.type === 'day') {
			toggleDay(row.day);
		} else if (row.type === 'commit') {
			toggleCommit(row.entry);
		} else if (row.type === 'path') {
			const relative = historyRelativePath(row.path.path, wcUrl, repositoryRoot);
			if (relative !== undefined) {
				openPreview(row.entry, relative);
			}
		}
	}

	function navigate(event: KeyboardEvent<HTMLDivElement>) {
		const target = event.target as HTMLElement;
		if (target.closest('.history-inline-diff') || (target !== event.currentTarget && !target.matches('[data-history-key]'))) {
			return;
		}
		const navigable = rows.filter((row) => ['day', 'commit', 'path'].includes(row.type));
		const index = navigable.findIndex((row) => row.key === activeKey);
		if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			const next =
				event.key === 'Home' ? 0 : event.key === 'End' ? navigable.length - 1 : Math.max(0, Math.min(navigable.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
			const row = navigable[next];
			if (row) {
				setActiveKey(row.key);
				event.currentTarget.focus();
				virtual.scrollToIndex(rows.indexOf(row), { align: 'auto' });
			}
		} else if (['Enter', ' '].includes(event.key) && target === event.currentTarget && index >= 0) {
			event.preventDefault();
			activate(navigable[index]);
		} else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && index >= 0) {
			const row = navigable[index];
			const collapsed = row.type === 'day' ? collapsedDates.has(row.day.key) : row.type === 'commit' ? collapsedRevisions.has(row.entry.revision) : undefined;
			if (collapsed !== undefined && collapsed === (event.key === 'ArrowRight')) {
				event.preventDefault();
				activate(row);
			}
		}
	}

	const activeRow = rows.find((row) => row.key === activeKey);
	const announcement =
		activeRow?.type === 'day'
			? activeRow.day.label
			: activeRow?.type === 'commit'
				? `r${activeRow.entry.revision}，${activeRow.entry.author}，${activeRow.entry.message}`
				: activeRow?.type === 'path'
					? `${actions[activeRow.path.action] ?? activeRow.path.action}，${activeRow.path.path}`
					: '';
	return (
		<>
			<div className="history-overview">
				<span>
					{t('historyTimeline.daysCommits', {
						count: days.length,
						count2: entries.length,
					})}
				</span>
				<div>
					<Button variant="ghost" size="sm" onClick={() => onChange({ historyCollapsedDates: days.map((day) => day.key) })}>
						<ChevronsDownUp />
						{t('historyTimeline.collapseAll')}
					</Button>
					<Button variant="ghost" size="sm" onClick={() => onChange({ historyCollapsedDates: [], historyCollapsedRevisions: [] })}>
						<ChevronsUpDown />
						{t('historyTimeline.expandAll')}
					</Button>
				</div>
			</div>
			<ScrollArea
				ref={viewport}
				className="history-timeline"
				role="region"
				aria-label={t('historyTimeline.historyTimelineArrowKeysToBrowseLeftAnd')}
				tabIndex={0}
				onKeyDown={navigate}
			>
				<span className="sr-only" role="status">
					{announcement}
				</span>
				<div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
					{virtual.getVirtualItems().map((item) => {
						const row = rows[item.index];
						return (
							<div key={item.key} className={`timeline-row timeline-${row.type}`} style={{ position: 'absolute', top: item.start, height: item.size, width: '100%' }}>
								{row.type === 'day' ? (
									<button
										className={`history-day ${activeKey === row.key ? 'keyboard-active' : ''}`}
										data-history-key={row.key}
										aria-expanded={!collapsedDates.has(row.day.key)}
										onFocus={() => setActiveKey(row.key)}
										onClick={() => toggleDay(row.day)}
									>
										{collapsedDates.has(row.day.key) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
										<strong>{row.day.label}</strong>
										<span>
											{t('historyTimeline.commitsPaths', {
												count: row.day.entries.length,
												pathCount: row.day.pathCount,
											})}
										</span>
									</button>
								) : row.type === 'commit' ? (
									<div className={`history-commit ${session.historyRevision === row.entry.revision ? 'selected' : ''}`} data-revision={row.entry.revision}>
										<button
											className={`history-commit-toggle ${activeKey === row.key ? 'keyboard-active' : ''}`}
											data-history-key={row.key}
											aria-expanded={!collapsedRevisions.has(row.entry.revision)}
											onFocus={() => setActiveKey(row.key)}
											onClick={() => toggleCommit(row.entry)}
										>
											{collapsedRevisions.has(row.entry.revision) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
											<span className="history-commit-text">
												<span className="history-commit-meta">
													<b className="revision">r{row.entry.revision}</b>
													<span className="truncate">{row.entry.author || t('detailsPanel.unknownAuthor')}</span>
													<time dateTime={row.entry.date}>
														{row.entry.date ? formatTime(row.entry.date, { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'}
													</time>
													<span>
														{t('historyTimeline.changes', {
															count: row.entry.paths.length,
														})}
													</span>
												</span>
												<span className="history-commit-summary truncate" title={row.entry.message}>
													{row.entry.message.split('\n')[0] || t('detailsPanel.noCommitMessage')}
												</span>
											</span>
										</button>
										<Button
											variant="outline"
											size="sm"
											aria-label={t('historyTimeline.viewChangesInR', {
												revision: row.entry.revision,
											})}
											aria-expanded={previewVisible && preview?.revision === row.entry.revision}
											onClick={() => (previewVisible && preview?.revision === row.entry.revision ? closePreview(row.entry.revision) : openPreview(row.entry))}
										>
											<FileDiff />
											{previewVisible && preview?.revision === row.entry.revision ? t('historyTimeline.collapseDiff') : t('historyTimeline.viewCommitDiff')}
										</Button>
									</div>
								) : row.type === 'path' ? (
									(() => {
										const relative = historyRelativePath(row.path.path, wcUrl, repositoryRoot);
										const selected = previewVisible && preview?.revision === row.entry.revision && previewPath === relative;
										return (
											<button
												className={`history-changed-path ${selected ? 'selected' : ''} ${activeKey === row.key ? 'keyboard-active' : ''}`}
												data-history-key={row.key}
												aria-label={`${actions[row.path.action] ?? row.path.action} ${row.path.path}`}
												aria-disabled={relative === undefined}
												title={`${row.path.path}${
													row.path.copyFrom
														? t('historyTimeline.copiedFrom', {
																copyFrom: row.path.copyFrom,
															})
														: ''
												}\n${relative === undefined ? t('historyTimeline.outsideTheCurrentWorkingCopy') : t('historyTimeline.viewThisFileSDiffInTheCommit')}`}
												onFocus={() => setActiveKey(row.key)}
												onClick={() => activate(row)}
												onDoubleClick={() => relative !== undefined && row.path.kind !== 'dir' && onCompare(relative, row.entry.revision)}
											>
												<span className={`path-action ${row.path.action}`} aria-hidden="true">
													{row.path.action}
												</span>
												<FileIcon path={row.path.path} kind={row.path.kind} size={16} />
												<span className="truncate">{row.path.path}</span>
												{row.path.copyFrom && <span className="history-copy-hint">{t('common.copy')}</span>}
												{relative === undefined && <span className="history-copy-hint">{t('historyTimeline.outsideWorkingCopy')}</span>}
											</button>
										);
									})()
								) : row.type === 'preview' ? (
									<HistoryComparison
										wcId={wcId}
										revision={row.entry.revision}
										path={previewPath}
										wholeCommit={previewPath === session.historyTarget}
										onVersions={() => onVersions(previewPath, row.entry.revision)}
										onClose={() => closePreview(row.entry.revision)}
										onCompare={
											previewPath !== '.' &&
											row.entry.paths.some((path) => path.kind !== 'dir' && historyRelativePath(path.path, wcUrl, repositoryRoot) === previewPath)
												? () => onCompare(previewPath, row.entry.revision)
												: undefined
										}
									/>
								) : null}
							</div>
						);
					})}
				</div>
			</ScrollArea>
		</>
	);
}
