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
	const projectName = (operation: Operation) => (operation.wcId ? (projects.get(operation.wcId)?.name ?? '已移除的工作副本') : '远端仓库');
	const projectOptions = useMemo(
		() => [
			{ value: 'all', label: '所有项目' },
			...Array.from(new Set(['remote', ...projects.keys(), ...operations.map((operation) => operation.wcId ?? 'remote')])).map((id) => ({
				value: id,
				label: id === 'remote' ? '远端仓库' : (projects.get(id)?.name ?? `已移除 · ${id.slice(0, 6)}`),
				description: projects.get(id)?.path,
			})),
		],
		[operations, projects],
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
					operation.label,
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
	}, [operations, project, status, deferredSearch, newest, projects]);
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
			toast.success('已复制日志');
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
			toast.success(`已清空 ${result.removedIds.length} 条日志`);
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
					<DialogTitle>操作日志</DialogTitle>
					<span className="logs-total">{operations.length} 条记录</span>
					{activeCount > 0 && (
						<span className="logs-live">
							<LoaderCircle size={12} className="spin" />
							{activeCount} 项进行中
						</span>
					)}
					<DialogDescription className="sr-only">查看 SVN 操作状态和真实命令输出。可搜索、筛选、复制或清空已结束的日志。</DialogDescription>
				</header>
				<div className="logs-toolbar">
					<label className="logs-search">
						<Search size={14} />
						<input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索操作、项目或输出…" aria-label="搜索日志" />
						{search && (
							<button aria-label="清除搜索" onClick={() => setSearch('')}>
								<X size={12} />
							</button>
						)}
					</label>
					<Select
						label="日志状态"
						value={status}
						onValueChange={setStatus}
						className="logs-status-filter"
						options={[
							{ value: 'all', label: '所有状态' },
							{ value: 'active', label: '进行中' },
							{ value: 'success', label: '已完成' },
							{ value: 'failed', label: '失败' },
							{ value: 'cancelled', label: '已取消' },
							{ value: 'uncertain', label: '结果待核实' },
						]}
					/>
					<Combobox label="日志项目" value={project} onValueChange={setProject} options={projectOptions} className="logs-project-filter" />
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
								清空日志
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
							<strong>清空这 {clearIds.length} 条日志？</strong>
							<p>仅删除当前筛选范围内已结束的本机记录。进行中的任务和新增日志会保留。</p>
							{uncertainCount > 0 && (
								<p className="logs-warning">
									<TriangleAlert size={14} />
									包含 {uncertainCount} 条结果待核实的记录，清空后仍需检查仓库历史。
								</p>
							)}
							<div>
								<Button variant="outline" disabled={clearing} onClick={() => setClearOpen(false)}>
									取消
								</Button>
								<Button variant="destructive" disabled={clearing} onClick={() => void clearLogs()}>
									{clearing && <LoaderCircle size={13} className="spin" />}确认清空
								</Button>
							</div>
						</PopoverContent>
					</Popover>
				</div>
				<div className="logs-records">
					{query.isPending ? (
						<div className="logs-empty">
							<LoaderCircle size={22} className="spin" />
							<strong>正在读取日志…</strong>
						</div>
					) : query.isError ? (
						<div className="logs-empty">
							<TriangleAlert size={22} />
							<strong>日志读取失败</strong>
							<Button variant="outline" onClick={() => void query.refetch()}>
								重新读取
							</Button>
						</div>
					) : !filtered.length ? (
						<div className="logs-empty">
							<FileText size={26} />
							<strong>{operations.length ? '没有匹配的日志' : '暂无操作日志'}</strong>
							<span>{operations.length ? '尝试更换关键词或筛选条件' : '更新、提交和文件操作的结果会显示在这里'}</span>
							{operations.length > 0 && (
								<Button
									variant="outline"
									onClick={() => {
										setSearch('');
										setStatus('all');
										setProject('all');
									}}
								>
									重置筛选
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
									aria-label="操作日志列表"
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
														时间
														<ChevronDown size={11} className={newest ? '' : 'logs-sort-up'} />
													</button>
												</th>
												<th>状态</th>
												<th>操作</th>
												<th>项目</th>
												<th>历时</th>
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
													<td title={operation.label}>{operation.label}</td>
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
									复制日志
								</ContextMenuItem>
								{selected && isOperationActive(selected) && (
									<ContextMenuItem icon={<Square size={13} />} onSelect={() => void api.call('cancel', { id: selected.id }).catch(notifyError)}>
										停止操作
									</ContextMenuItem>
								)}
							</ContextMenuContent>
						</ContextMenu>
					)}
				</div>
				<section className="logs-detail" aria-label="选中日志详情">
					{selected ? (
						<>
							<div className="logs-detail-heading">
								<div>
									<strong>{selected.label}</strong>
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
									复制
								</Button>
								{isOperationActive(selected) && (
									<Button variant="outline" onClick={() => void api.call('cancel', { id: selected.id }).catch(notifyError)}>
										<Square size={12} />
										停止
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
											核实历史
										</Button>
									)}
								</div>
							)}
							{selected.state === 'cancelled' && <div className="logs-note">操作已取消，已完成的修改不会回滚。</div>}
							<OperationOutput key={selected.id} operation={selected} />
						</>
					) : (
						<div className="logs-empty">
							<FileText size={24} />
							<span>选择一条记录查看输出</span>
						</div>
					)}
				</section>
				<footer className="logs-footer">
					<span>
						显示 {filtered.length} / {operations.length} 条{activeCount ? ` · ${activeCount} 项进行中` : ''}
					</span>
					<span>保留最近 100 条已结束记录 · 存储于本机</span>
				</footer>
			</DialogContent>
		</Dialog>
	);
}
