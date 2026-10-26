import { useTranslation } from 'react-i18next';
import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, LoaderCircle, MoreHorizontal, Search } from 'lucide-react';
import { isChanged, isConflict, type FileStatus, type Filter, type WorkingCopy, type WorkspaceSession } from '../../../shared/types';
import { useStatus } from '../queries/hooks';
import { useSessionSlice, workspaceStore } from '../state/workspace';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu';
import { VirtualList } from './VirtualList';
import { FileTreeName } from './FileTreeName';
import { Combobox } from './ui/combobox';
import { Button } from './ui/button';
import { fileState, filters, leaf, parent, StatusBadge } from './file-presentation';
export type FileContext = { x: number; y: number; path: string };

export function FilePane({
	wc,
	height,
	fileActions,
	setContext,
	compareFile,
	onTogglePreview,
}: {
	wc: WorkingCopy;
	height?: number;
	fileActions: (path: string) => ReactNode;
	setContext: (context: FileContext) => void;
	compareFile: (path: string) => void;
	onTogglePreview: () => void;
}) {
	const { t } = useTranslation();
	const session = useSessionSlice(wc.id, ['currentPath', 'expanded', 'view', 'filter', 'fileSearch']);

	const patchSession = (patch: Partial<WorkspaceSession>) => workspaceStore.getState().patchSession(patch, wc.id);

	const status = useStatus(wc.id);
	const snapshot = status.data;
	const currentFile = snapshot?.files.find((file) => file.path === session.currentPath);
	const changed = snapshot?.files.filter(isChanged) ?? [];
	const fileSearch = session.fileSearch ?? '';
	const fileHeader = useRef<HTMLDivElement>(null);
	const pane = useRef<HTMLDivElement>(null);
	const visibleFiles = useMemo(() => {
		const all = snapshot?.files ?? [];
		const changes = all.filter((file) => isChanged(file) || file.item === 'unversioned' || file.item === 'ignored');
		const tree = session.filter === 'all' && !fileSearch;
		const included = new Set(changes.filter((file) => file.item !== 'ignored').map((file) => file.path));
		if (session.view === 'changes' && tree) {
			for (const file of changes) {
				if (file.item === 'ignored') {
					continue;
				}
				let path = parent(file.path);
				included.add('.');
				while (path) {
					included.add(path);
					path = parent(path);
				}
			}
		}
		const source = session.view === 'files' ? all : tree ? all.filter((file) => included.has(file.path)) : changes;
		return source.filter((file) => {
			const status = fileState(file);
			if (session.filter === 'all' && session.view !== 'files' && file.item === 'ignored') {
				return false;
			}
			if (session.filter !== 'all' && (session.filter === 'deleted' ? !['deleted', 'missing'].includes(status) : status !== session.filter)) {
				return false;
			}
			if (fileSearch && !file.path.toLocaleLowerCase().includes(fileSearch.toLocaleLowerCase())) {
				return false;
			}
			if (tree && file.path !== '.') {
				if (!session.expanded.includes('.')) {
					return false;
				}
				const ancestors = parent(file.path).split('/').filter(Boolean);
				let path = '';
				for (const ancestor of ancestors) {
					path = path ? `${path}/${ancestor}` : ancestor;
					if (!session.expanded.includes(path)) {
						return false;
					}
				}
			}
			return true;
		});
	}, [snapshot, session.view, session.filter, session.expanded, fileSearch]);
	const changedDirectories = useMemo(() => {
		const paths = new Set<string>();
		for (const file of snapshot?.files ?? []) {
			if (!isChanged(file)) {
				continue;
			}
			paths.add('.');
			let path = parent(file.path);
			while (path) {
				paths.add(path);
				path = parent(path);
			}
		}
		return paths;
	}, [snapshot]);
	const treeView = session.filter === 'all' && !fileSearch;
	const depthOf = useCallback((file: FileStatus) => (treeView && file.path !== '.' ? file.path.split('/').length : 0), [treeView]);
	const fileListMinWidth = useMemo(() => 458 + visibleFiles.reduce((depth, file) => Math.max(depth, depthOf(file)), 0) * 16, [visibleFiles, depthOf]);
	const alignHeader = useCallback((viewport: HTMLElement) => {
		const header = fileHeader.current;
		if (header) {
			// Keep columns aligned when a visible scrollbar consumes content width.
			header.style.marginRight = `${viewport.offsetWidth - viewport.clientWidth}px`;
			header.scrollLeft = viewport.scrollLeft;
		}
	}, []);
	useLayoutEffect(() => {
		const viewport = pane.current?.querySelector<HTMLElement>('.virtual-list');
		if (!viewport) {
			if (fileHeader.current) {
				fileHeader.current.style.marginRight = '0px';
			}
			return;
		}
		const observer = new ResizeObserver(() => alignHeader(viewport));
		observer.observe(viewport);
		alignHeader(viewport);
		return () => observer.disconnect();
	}, [visibleFiles.length, alignHeader]);

	function navigateList(event: React.KeyboardEvent<HTMLDivElement>) {
		const target = event.target as HTMLElement;
		if (target.matches('input,textarea,select')) {
			return;
		}
		if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
			const length = visibleFiles.length;
			if (!length) {
				return;
			}
			event.preventDefault();
			event.currentTarget.focus();
			const index = visibleFiles.findIndex((file) => file.path === session.currentPath);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : Math.max(0, Math.min(length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
			patchSession({ currentPath: visibleFiles[next].path });
		} else if (event.key === ' ' && currentFile) {
			event.preventDefault();
			onTogglePreview();
		} else if (['ArrowRight', 'ArrowLeft'].includes(event.key) && treeView && currentFile) {
			event.preventDefault();
			event.currentTarget.focus();
			const expanded = session.expanded.includes(currentFile.path);
			if (event.key === 'ArrowRight' && currentFile.kind === 'dir') {
				if (!expanded) {
					patchSession({ expanded: [...session.expanded, currentFile.path] });
				} else {
					const next = visibleFiles[visibleFiles.findIndex((file) => file.path === currentFile.path) + 1];
					if (next && (currentFile.path === '.' || next.path.startsWith(`${currentFile.path}/`))) {
						patchSession({ currentPath: next.path });
					}
				}
			} else if (event.key === 'ArrowLeft') {
				if (currentFile.kind === 'dir' && expanded) {
					patchSession({ expanded: session.expanded.filter((path) => path !== currentFile.path) });
				} else if (currentFile.path !== '.') {
					patchSession({ currentPath: parent(currentFile.path) || '.' });
				}
			}
		} else if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && session.currentPath) {
			event.preventDefault();
			const rect = event.currentTarget.getBoundingClientRect();
			setContext({ x: rect.x + 70, y: rect.y + 80, path: session.currentPath });
		}
	}

	return (
		<div
			ref={pane}
			className="file-pane"
			style={height ? { height } : undefined}
			tabIndex={0}
			aria-label={t('filePane.fileAndHistoryListArrowKeysToBrowse')}
			onKeyDown={navigateList}
			onScrollCapture={(event) => {
				const target = event.target as HTMLElement;
				if (target.classList.contains('virtual-list')) {
					alignHeader(target);
				}
			}}
		>
			<div className="workspace-toolbar filter-toolbar">
				<label className="changed-toggle">
					<input
						type="checkbox"
						aria-label={t('filePane.changesOnly')}
						checked={session.view === 'changes'}
						onChange={(event) => patchSession({ view: event.target.checked ? 'changes' : 'files', filter: 'all' })}
					/>
					{t('filePane.changesOnly')}
				</label>
				<Combobox
					label={t('filePane.fileStatusFilter')}
					className="status-filter"
					value={session.filter}
					onValueChange={(value) => patchSession({ filter: value as Filter })}
					options={filters.map((filter) => ({
						value: filter.value,
						label: filter.value === 'all' ? t('filePane.allStatuses') : filter.label,
					}))}
				/>
				{snapshot?.files.some(isConflict) && (
					<Button variant="ghost" size="sm" className="conflict-filter" onClick={() => patchSession({ filter: 'conflicted' })}>
						<span className="conflict-dot" />
						{t('filePane.conflicts')}
						{snapshot.files.filter(isConflict).length}
					</Button>
				)}
				<div className="inline-search">
					<Search size={12} />
					<input
						aria-label={t('filePane.searchFiles')}
						placeholder={t('filePane.filterPaths')}
						value={fileSearch}
						onChange={(event) => patchSession({ fileSearch: event.target.value })}
					/>
				</div>
			</div>
			<div className="file-table-header" ref={fileHeader}>
				<div className="table-head file-columns" style={{ minWidth: fileListMinWidth }}>
					<span>
						{t('filePane.name')}
						<ChevronDown size={10} />
					</span>
					<span>{t('common.status')}</span>
					<span>{t('detailsPanel.revision')}</span>
					<span>{t('filePane.author')}</span>
				</div>
			</div>
			{status.isFetching && !snapshot ? (
				<div className="empty">
					<LoaderCircle className="spin" />
					{t('filePane.scanningWorkingCopy')}
				</div>
			) : !visibleFiles.length ? (
				<div className="empty">
					<CheckCircle2 size={30} />
					<strong>{snapshot && !changed.length && !fileSearch ? t('filePane.workingCopyIsClean') : t('filePane.noMatchingFiles')}</strong>
					<span>{snapshot ? t('filePane.localStatusCheckedCheckRemoteChangesOrChoose') : t('filePane.refreshToReadLocalStatus')}</span>
				</div>
			) : (
				<VirtualList
					items={visibleFiles}
					activeIndex={visibleFiles.findIndex((file) => file.path === session.currentPath)}
					label={t('filePane.workingCopyFiles')}
					height={26}
					minWidth={fileListMinWidth}
					render={(file) => (
						<div
							className={`file-row file-columns ${session.currentPath === file.path ? 'selected' : ''}`}
							data-path={file.path}
							data-depth={depthOf(file)}
							onContextMenu={(event) => {
								event.preventDefault();
								patchSession({ currentPath: file.path });
								setContext({ x: event.clientX, y: event.clientY, path: file.path });
							}}
						>
							<FileTreeName
								file={file}
								name={file.path === '.' ? wc.name : leaf(file.path)}
								depth={depthOf(file)}
								expanded={session.expanded.includes(file.path)}
								showParent={!treeView}
								onSelect={() => patchSession({ currentPath: file.path })}
								onToggle={() =>
									patchSession({
										expanded: session.expanded.includes(file.path) ? session.expanded.filter((path) => path !== file.path) : [...session.expanded, file.path],
									})
								}
								onOpen={() => {
									if (file.kind === 'file') {
										void compareFile(file.path);
									}
								}}
							/>
							<span>
								{file.kind === 'dir' && !isChanged(file) && changedDirectories.has(file.path) ? (
									<span className="folder-changes">{t('filePane.containsChanges')}</span>
								) : fileState(file) === 'normal' || fileState(file) === 'none' ? (
									<span className="normal-file-state" aria-label={t('filePane.noLocalChanges')}>
										—
									</span>
								) : (
									<StatusBadge file={file} />
								)}
							</span>
							<span className="mono muted file-revision">{file.revision && file.revision !== '-1' ? `r${file.revision}` : '—'}</span>
							<div className="row-author">
								<span className="truncate muted">{file.author || '—'}</span>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button
											className="row-more"
											aria-label={t('filePane.actionsFor', {
												path: file.path,
											})}
										>
											<MoreHorizontal size={14} />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">{fileActions(file.path)}</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</div>
					)}
				/>
			)}
			<div className="list-footer">
				<span>
					{t('filePane.paths', { count: visibleFiles.length })}
					<span className="separator-dot">·</span>
					{t('filePane.changes', { count: changed.length })}
					{snapshot?.files.some((file) => file.external) && t('filePane.externalsManagedSeparately')}
				</span>
				<span>{t('filePane.selectAFileForDetailsChooseTheScope')}</span>
			</div>
		</div>
	);
}
