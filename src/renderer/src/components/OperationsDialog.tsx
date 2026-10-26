import { operationLabel } from '../../../shared/operation-log';
import { useTranslation } from 'react-i18next';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Copy, FileText, LoaderCircle, Search, Square, Trash2, TriangleAlert, X } from 'lucide-react';
import { isOperationActive, type Operation } from '../../../shared/types';
import { svnQueries } from '../queries/runtime';
import { useWorkspaceStore, workspaceStore } from '../state/workspace';
import { api } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { toast } from 'sonner';
import { operationDuration, operationOutput } from '../lib/operation-log';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import { Select } from './ui/select';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from './ui/context-menu';
import { fmtDate, opLabels } from './file-presentation';
import { OperationOutput, OperationStatus } from './OperationOutput';

const closeOperations = () => workspaceStore.getState().setPanel('showOperations', false);

export function OperationsDialog({ onVerify }: { onVerify: (id: string) => void }) {
	const { t } = useTranslation();
	const query = useQuery(svnQueries.operationOptions());
	const operations = query.data ?? [];
	const copies = useWorkspaceStore((store) => store.catalog?.workingCopies);
	const [search, setSearch] = useState('');
	const deferredSearch = useDeferredValue(search);
	const [status, setStatus] = useState('all');
	const [project, setProject] = useState('all');
	const [selectedId, setSelectedId] = useState<string>();
	const [newest, setNewest] = useState(true);
	const [now, setNow] = useState(Date.now);
	const [clearOpen, setClearOpen] = useState(false);
	const [clearIds, setClearIds] = useState<string[]>([]);
	const [clearing, setClearing] = useState(false);
	const clearLock = useRef(false);
	const searchInput = useRef<HTMLInputElement>(null);
	const table = useRef<HTMLDivElement>(null);
	const projects = useMemo(() => new Map(copies?.map((copy) => [copy.id, copy])), [copies]);

	const projectName = (operation: Operation) =>
		operation.wcId ? (projects.get(operation.wcId)?.name ?? t('operationsDialog.removedWorkingCopy')) : t('common.remoteRepository');

	const projectOptions = useMemo(
		() => [
			{
				value: 'all',
				label: t('operationsDialog.allProjects'),
			},
			...Array.from(new Set(['remote', ...projects.keys(), ...operations.map((operation) => operation.wcId ?? 'remote')])).map((id) => ({
				value: id,
				label:
					id === 'remote'
						? t('common.remoteRepository')
						: (projects.get(id)?.name ??
							t('operationsDialog.removed', {
								value: id.slice(0, 6),
							})),
				description: projects.get(id)?.path,
			})),
		],
		[operations, projects, t],
	);
	const filtered = useMemo(() => {
		const needle = deferredSearch.trim().toLocaleLowerCase();
		const records = operations.filter((operation) => {
			if (project !== 'all' && (operation.wcId ?? 'remote') !== project) {
				return false;
			}
			if (status !== 'all' && !(status === 'active' ? isOperationActive(operation) : operation.state === status)) {
				return false;
			}
			return (
				!needle ||
				[
					operationLabel(operation),
					projects.get(operation.wcId ?? '')?.name,
					projects.get(operation.wcId ?? '')?.path,
					opLabels[operation.state],
					fmtDate(operation.startedAt),
					operation.error?.message,
					operationOutput(operation),
				]
					.join('\n')
					.toLocaleLowerCase()
					.includes(needle)
			);
		});
		return newest ? records : records.toReversed();
	}, [operations, project, status, deferredSearch, newest, projects, t]);
	const selected = filtered.find((operation) => operation.id === selectedId) ?? filtered[0];
	const removable = filtered.filter((operation) => !isOperationActive(operation));
	const activeCount = operations.filter(isOperationActive).length;
	const uncertainCount = operations.filter((operation) => clearIds.includes(operation.id) && operation.state === 'uncertain').length;
	useEffect(() => {
		if (!activeCount) {
			return;
		}
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [activeCount]);
	useEffect(() => {
		table.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
	}, [selected?.id]);

	async function copyLog(operation: Operation) {
		try {
			await api.call('copyOperation', { id: operation.id });
			toast.success(t('operationsDialog.logCopied'));
		} catch (error) {
			notifyError(error);
		}
	}

	async function clearLogs() {
		if (clearLock.current) {
			return;
		}
		clearLock.current = true;
		setClearing(true);
		try {
			const result = await svnQueries.clearOperations(clearIds);
			setClearOpen(false);
			toast.success(
				t('operationsDialog.clearedLogs', {
					count: result.removedIds.length,
				}),
			);
		} catch (error) {
			notifyError(error);
		} finally {
			clearLock.current = false;
			setClearing(false);
		}
	}

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !clearLock.current) {
					closeOperations();
				}
			}}
		>
			<DialogContent
				className="operations-dialog"
				onKeyDown={(event) => {
					if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
						event.preventDefault();
						searchInput.current?.focus();
					}
				}}
			>
				<header className="logs-heading">
					<FileText size={18} />
					<DialogTitle>{t('operationsDialog.operationLog')}</DialogTitle>
					<span className="logs-total">
						{t('operationsDialog.records', {
							count: operations.length,
						})}
					</span>
					{activeCount > 0 && (
						<span className="logs-live">
							<LoaderCircle size={12} className="spin" />
							{activeCount}
							{t('operationsDialog.inProgress')}
						</span>
					)}
					<DialogDescription className="sr-only">{t('operationsDialog.viewSvnOperationStatusAndActualCommandOutput')}</DialogDescription>
				</header>
				<div className="logs-toolbar">
					<label className="logs-search">
						<Search size={14} />
						<input
							ref={searchInput}
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder={t('operationsDialog.searchOperationsProjectsOrOutput')}
							aria-label={t('operationsDialog.searchLogs')}
						/>
						{search && (
							<button aria-label={t('operationsDialog.clearSearch')} onClick={() => setSearch('')}>
								<X size={12} />
							</button>
						)}
					</label>
					<Select
						label={t('operationsDialog.logStatus')}
						value={status}
						onValueChange={setStatus}
						className="logs-status-filter"
						options={[
							{
								value: 'all',
								label: t('operationsDialog.allStatuses'),
							},
							{
								value: 'active',
								label: t('operationsDialog.inProgress2'),
							},
							{
								value: 'success',
								label: t('operations.success'),
							},
							{
								value: 'failed',
								label: t('operations.failed'),
							},
							{
								value: 'cancelled',
								label: t('operations.cancelled'),
							},
							{
								value: 'uncertain',
								label: t('operations.uncertain'),
							},
						]}
					/>
					<Combobox label={t('operationsDialog.logProject')} value={project} onValueChange={setProject} options={projectOptions} className="logs-project-filter" />
					<Popover
						open={clearOpen}
						onOpenChange={(open) => {
							if (!clearLock.current) {
								if (open) {
									setClearIds(removable.map((operation) => operation.id));
								}
								setClearOpen(open);
							}
						}}
					>
						<PopoverTrigger asChild>
							<Button variant="outline" disabled={!removable.length} className="logs-clear">
								<Trash2 size={13} />
								{t('operationsDialog.clearLogs')}
							</Button>
						</PopoverTrigger>
						<PopoverContent
							className="logs-clear-confirm"
							align="end"
							onEscapeKeyDown={(event) => {
								if (clearing) {
									event.preventDefault();
								}
							}}
							onInteractOutside={(event) => {
								if (clearing) {
									event.preventDefault();
								}
							}}
						>
							<strong>
								{t('operationsDialog.clearTheseLogs', {
									count: clearIds.length,
								})}
							</strong>
							<p>{t('operationsDialog.onlyCompletedLocalRecordsMatchingTheCurrentFilters')}</p>
							{uncertainCount > 0 && (
								<p className="logs-warning">
									<TriangleAlert size={14} />
									{t('operationsDialog.uncertainRecords', { count: uncertainCount })}
								</p>
							)}
							<div>
								<Button variant="outline" disabled={clearing} onClick={() => setClearOpen(false)}>
									{t('common.cancel')}
								</Button>
								<Button variant="destructive" disabled={clearing} onClick={() => void clearLogs()}>
									{clearing && <LoaderCircle size={13} className="spin" />}
									{t('operationsDialog.confirmClear')}
								</Button>
							</div>
						</PopoverContent>
					</Popover>
				</div>
				<div className="logs-records">
					{query.isPending ? (
						<div className="logs-empty">
							<LoaderCircle size={22} className="spin" />
							<strong>{t('operationsDialog.loadingLogs')}</strong>
						</div>
					) : query.isError ? (
						<div className="logs-empty">
							<TriangleAlert size={22} />
							<strong>{t('operationsDialog.unableToLoadLogs')}</strong>
							<Button variant="outline" onClick={() => void query.refetch()}>
								{t('historyComparison.reload')}
							</Button>
						</div>
					) : !filtered.length ? (
						<div className="logs-empty">
							<FileText size={26} />
							<strong>{operations.length ? t('operationsDialog.noMatchingLogs') : t('operationsDialog.noOperationLogsYet')}</strong>
							<span>
								{operations.length ? t('operationsDialog.tryDifferentKeywordsOrFilters') : t('operationsDialog.resultsFromUpdatesCommitsAndFileOperationsAppear')}
							</span>
							{operations.length > 0 && (
								<Button
									variant="outline"
									onClick={() => {
										setSearch('');
										setStatus('all');
										setProject('all');
									}}
								>
									{t('operationsDialog.resetFilters')}
								</Button>
							)}
						</div>
					) : (
						<ContextMenu>
							<ContextMenuTrigger asChild>
								<div
									ref={table}
									className="logs-table-scroll"
									tabIndex={0}
									role="grid"
									aria-label={t('operationsDialog.operationLogList')}
									aria-activedescendant={selected ? `log-${selected.id}` : undefined}
									onKeyDown={(event) => {
										if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selected) {
											event.preventDefault();
											void copyLog(selected);
											return;
										}
										if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
											return;
										}
										event.preventDefault();
										const index = filtered.findIndex((operation) => operation.id === selected?.id);
										const next =
											event.key === 'Home'
												? 0
												: event.key === 'End'
													? filtered.length - 1
													: Math.max(0, Math.min(filtered.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
										setSelectedId(filtered[next].id);
									}}
								>
									<table>
										<colgroup>
											<col className="logs-time-col" />
											<col className="logs-state-col" />
											<col />
											<col className="logs-project-col" />
											<col className="logs-duration-col" />
										</colgroup>
										<thead>
											<tr>
												<th>
													<button onClick={() => setNewest(!newest)}>
														{t('operationsDialog.time')}
														<ChevronDown size={11} className={newest ? '' : 'logs-sort-up'} />
													</button>
												</th>
												<th>{t('common.status')}</th>
												<th>{t('operationsDialog.operation')}</th>
												<th>{t('operationsDialog.project')}</th>
												<th>{t('operationsDialog.duration')}</th>
											</tr>
										</thead>
										<tbody>
											{filtered.map((operation) => (
												<tr
													key={operation.id}
													id={`log-${operation.id}`}
													data-operation-id={operation.id}
													aria-selected={selected?.id === operation.id}
													onClick={() => {
														setSelectedId(operation.id);
														table.current?.focus({ preventScroll: true });
													}}
													onContextMenu={() => setSelectedId(operation.id)}
												>
													<td className="logs-time">{fmtDate(operation.startedAt)}</td>
													<td>
														<OperationStatus operation={operation} />
													</td>
													<td title={operationLabel(operation)}>{operationLabel(operation)}</td>
													<td title={projectName(operation)}>{projectName(operation)}</td>
													<td className="logs-duration">{operationDuration(operation, now)}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</ContextMenuTrigger>
							<ContextMenuContent>
								<ContextMenuItem
									icon={<Copy size={13} />}
									shortcut="⌘C"
									onSelect={() => {
										if (selected) {
											void copyLog(selected);
										}
									}}
								>
									{t('operationsDialog.copyLog')}
								</ContextMenuItem>
								{selected && isOperationActive(selected) && (
									<ContextMenuItem icon={<Square size={13} />} onSelect={() => void api.call('cancel', { id: selected.id }).catch(notifyError)}>
										{t('operationsDialog.stopOperation')}
									</ContextMenuItem>
								)}
							</ContextMenuContent>
						</ContextMenu>
					)}
				</div>
				<section className="logs-detail" aria-label={t('operationsDialog.selectedLogDetails')}>
					{selected ? (
						<>
							<div className="logs-detail-heading">
								<div>
									<strong>{operationLabel(selected)}</strong>
									<span>
										{projectName(selected)}
										<i />
										{fmtDate(selected.startedAt)}
										{selected.endedAt ? ` → ${fmtDate(selected.endedAt)}` : ''}
									</span>
								</div>
								<OperationStatus operation={selected} />
								<Button variant="outline" onClick={() => void copyLog(selected)}>
									<Copy size={13} />
									{t('common.copy')}
								</Button>
								{isOperationActive(selected) && (
									<Button variant="outline" onClick={() => void api.call('cancel', { id: selected.id }).catch(notifyError)}>
										<Square size={12} />
										{t('operationsDialog.stop')}
									</Button>
								)}
							</div>
							{selected.error && selected.state !== 'cancelled' && (
								<div className={`logs-note ${selected.state}`}>
									<TriangleAlert size={14} />
									<span>{selected.error.message}</span>
									{selected.state === 'uncertain' && selected.wcId && projects.has(selected.wcId) && (
										<Button
											variant="outline"
											onClick={() => {
												onVerify(selected.wcId!);
												closeOperations();
											}}
										>
											{t('operationsDialog.verifyHistory')}
										</Button>
									)}
								</div>
							)}
							{selected.state === 'cancelled' && <div className="logs-note">{t('operationsDialog.operationCancelledCompletedChangesWillNotBeUndone')}</div>}
							<OperationOutput key={selected.id} operation={selected} />
						</>
					) : (
						<div className="logs-empty">
							<FileText size={24} />
							<span>{t('operationsDialog.selectARecordToViewItsOutput')}</span>
						</div>
					)}
				</section>
				<footer className="logs-footer">
					<span>
						{t('operationsDialog.showingOf', {
							count: filtered.length,
							count2: operations.length,
							value: activeCount
								? t('operationsDialog.inProgress3', {
										activeCount: activeCount,
									})
								: '',
						})}
					</span>
					<span>{t('operationsDialog.latestCompletedRecordsStoredOnThisMac')}</span>
				</footer>
			</DialogContent>
		</Dialog>
	);
}
