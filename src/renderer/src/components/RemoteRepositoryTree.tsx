import { useEffect, useId, useImperativeHandle, useRef, useState, type Ref, type KeyboardEvent } from 'react';
import { isCancelledError } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Cloud, CircleAlert, LoaderCircle, RefreshCw, Square, X } from 'lucide-react';
import type { RemoteEntry } from '../../../shared/types';
import { svnQueries } from '../queries/runtime';
import { workspaceStore } from '../state/workspace';
import { errorText } from '../lib/api';
import { FileIcon } from './FileIcon';
import { fmtDate } from './file-presentation';
import { VirtualList } from './VirtualList';

type Directory = { state: 'loading' | 'loaded' | 'error' | 'cancelled' | 'idle'; entries?: RemoteEntry[]; error?: string };
type TreeRow = { url: string; name: string; kind: string; depth: number; position: number; total: number; parent?: string; entry?: RemoteEntry; status?: Directory };
export type RemoteTreeHandle = { cancel: () => void };

export function remoteName(url: string): string {
	try {
		return decodeURIComponent(new URL(url).pathname.replace(/\/$/, '').split('/').at(-1) || '');
	} catch {
		return '';
	}
}

export function RemoteRepositoryTree({
	ref,
	rootUrl,
	rootName,
	entries,
	rootState,
	rootError,
	repositoryId,
	selectedUrl,
	onSelect,
	onPendingChange,
	onRetry,
	onCancel,
}: {
	ref?: Ref<RemoteTreeHandle>;
	rootUrl: string;
	rootName: string;
	entries: RemoteEntry[];
	rootState: Directory['state'];
	rootError: string;
	repositoryId: string;
	selectedUrl: string;
	onSelect: (url: string, kind: string) => void;
	onPendingChange: (count: number) => void;
	onRetry: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	const treeId = useId();
	const [directories, setDirectories] = useState<Record<string, Directory>>({});
	const [expanded, setExpanded] = useState(() => new Set([rootUrl]));
	const requests = useRef(new Map<string, AbortController>());
	const header = useRef<HTMLDivElement>(null);
	const tree = useRef<HTMLDivElement>(null);
	const pending = Object.values(directories).filter((directory) => directory.state === 'loading').length;
	useEffect(() => {
		onPendingChange(pending);
	}, [pending, onPendingChange]);

	useEffect(() => {
		const active = requests.current;
		return () => {
			for (const controller of active.values()) {
				controller.abort();
			}
			active.clear();
		};
	}, []);

	useImperativeHandle(ref, () => ({ cancel: () => cancel() }));

	function cancel(prefix?: string) {
		const cancelled: string[] = [];
		for (const [url, controller] of requests.current) {
			if (!prefix || url === prefix || url.startsWith(`${prefix.replace(/\/$/, '')}/`)) {
				requests.current.delete(url);
				controller.abort();
				cancelled.push(url);
			}
		}
		setDirectories((previous) => {
			const next = { ...previous };
			for (const url of cancelled) {
				next[url] = { ...next[url], state: 'cancelled' };
			}
			return next;
		});
	}

	async function load(url: string) {
		if (requests.current.has(url)) {
			return;
		}
		const controller = new AbortController();
		requests.current.set(url, controller);
		setDirectories((previous) => ({ ...previous, [url]: { state: 'loading' } }));
		const options = svnQueries.listOptions(url, repositoryId || undefined, workspaceStore.getState().connectionVersion);
		const abort = () => {
			void svnQueries.client.cancelQueries({ queryKey: options.queryKey, exact: true });
		};

		controller.signal.addEventListener('abort', abort, { once: true });
		try {
			const entries = await svnQueries.client.fetchQuery({ ...options, staleTime: 0 });
			if (requests.current.get(url) === controller) {
				setDirectories((previous) => ({ ...previous, [url]: { state: 'loaded', entries } }));
			}
		} catch (error) {
			if (requests.current.get(url) === controller) {
				const cancelled = controller.signal.aborted || isCancelledError(error) || (error as { kind?: string })?.kind === 'cancelled';
				setDirectories((previous) => ({ ...previous, [url]: { state: cancelled ? 'cancelled' : 'error', error: cancelled ? undefined : errorText(error) } }));
			}
		} finally {
			controller.signal.removeEventListener('abort', abort);
			if (requests.current.get(url) === controller) {
				requests.current.delete(url);
			}
		}
	}

	const rootDirectory: Directory = { state: rootState, entries: rootState === 'loaded' ? entries : undefined, error: rootError };
	const rows: TreeRow[] = [];
	const directoryFor = (url: string) => (url === rootUrl ? rootDirectory : directories[url]);
	const append = (row: TreeRow) => {
		rows.push(row);
		if (row.kind !== 'dir' || !expanded.has(row.url)) {
			return;
		}
		const directory = directoryFor(row.url);
		if (!directory || directory.state === 'loading') {
			return;
		}
		if (directory.state !== 'loaded' || !directory.entries?.length) {
			rows.push({ ...row, depth: row.depth + 1, status: directory });
			return;
		}
		const children = [...directory.entries].sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name));
		for (const [index, entry] of children.entries()) {
			append({
				url: `${row.url.replace(/\/$/, '')}/${encodeURIComponent(entry.name)}`,
				name: entry.name,
				kind: entry.kind,
				entry,
				depth: row.depth + 1,
				parent: row.url,
				position: index + 1,
				total: children.length,
			});
		}
	};

	if (rootUrl) {
		append({ url: rootUrl, name: rootName, kind: 'dir', depth: 0, position: 1, total: 1 });
	}
	const activeIndex = rows.findIndex((row) => !row.status && row.url === selectedUrl);
	const minWidth = 660 + rows.reduce((depth, row) => Math.max(depth, row.depth), 0) * 16;

	function focusTree() {
		tree.current?.querySelector<HTMLElement>('[role="tree"]')?.focus();
	}

	function select(row: TreeRow) {
		if (rootState === 'loaded') {
			onSelect(row.url, row.kind);
		}
	}

	function toggle(row: TreeRow) {
		const open = expanded.has(row.url);
		setExpanded((previous) => {
			const next = new Set(previous);
			if (open) {
				next.delete(row.url);
			} else {
				next.add(row.url);
			}
			return next;
		});
		if (open) {
			cancel(row.url);
			if (row.url === rootUrl && rootState === 'loading') {
				onCancel();
			}
			if (selectedUrl.startsWith(`${row.url.replace(/\/$/, '')}/`)) {
				select(row);
			}
		} else if (row.url === rootUrl) {
			if (rootState !== 'loaded') {
				onRetry();
			}
		} else if (directoryFor(row.url)?.state !== 'loaded') {
			void load(row.url);
		}
	}

	function keyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.target instanceof HTMLButtonElement) {
			return;
		}
		const nodes = rows.filter((row) => !row.status);
		const index = nodes.findIndex((row) => row.url === selectedUrl);
		const row = nodes[index < 0 ? 0 : index];
		if (!row || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
			return;
		}
		event.preventDefault();
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : Math.max(0, Math.min(nodes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
			select(nodes[next]);
		} else if (event.key === 'ArrowLeft') {
			if (row.kind === 'dir' && expanded.has(row.url)) {
				toggle(row);
			} else if (row.parent) {
				select(nodes.find((node) => node.url === row.parent)!);
			}
		} else if (row.kind === 'dir') {
			if (event.key === 'ArrowRight' && expanded.has(row.url)) {
				const child = nodes[index + 1];
				if (child?.parent === row.url) {
					select(child);
				}
			} else {
				toggle(row);
			}
		}
	}

	function statusText(directory: Directory) {
		return directory.state === 'error'
			? directory.error?.split('\n')[0]
			: directory.state === 'cancelled'
				? t('common.connectionStopped')
				: directory.state === 'idle'
					? t('dialogs.notConnectedToARepository')
					: t('remoteTree.emptyDirectory');
	}

	return (
		<div className="remote-list remote-tree" ref={tree} onKeyDown={keyDown}>
			<div className="remote-tree-header" ref={header} aria-hidden="true">
				<div className="remote-columns" style={{ minWidth }}>
					<span>{t('remoteTree.name')}</span>
					<span>{t('remoteTree.revision')}</span>
					<span>{t('remoteTree.date')}</span>
					<span>{t('remoteTree.author')}</span>
				</div>
			</div>
			{!rootUrl ? (
				<div className="empty">
					<Cloud size={24} />
					{t('dialogs.notConnectedToARepository')}
				</div>
			) : (
				<VirtualList
					items={rows}
					height={26}
					minWidth={minWidth}
					label={t('dialogs.remoteDirectory')}
					role="tree"
					tabIndex={0}
					activeIndex={activeIndex}
					activeDescendant={activeIndex >= 0 ? `${treeId}-${activeIndex}` : undefined}
					onScroll={(event) => {
						if (header.current) {
							header.current.scrollLeft = event.currentTarget.scrollLeft;
						}
					}}
					render={(row, index) => {
						const directory = directoryFor(row.url);
						const loading = row.kind === 'dir' && directory?.state === 'loading';
						if (row.status) {
							const retry = row.status.state === 'error' || row.status.state === 'cancelled';
							return (
								<div className={`remote-tree-status ${row.status.state === 'error' ? 'error-text' : ''}`} style={{ paddingLeft: 50 + row.depth * 16 }}>
									{row.status.state === 'error' ? <CircleAlert size={12} /> : row.status.state === 'cancelled' ? <Square size={11} /> : null}
									<span className="truncate" title={row.status.error} role={row.status.state === 'error' ? 'alert' : 'status'}>
										{statusText(row.status)}
									</span>
									{retry && (
										<button
											onClick={() => {
												row.url === rootUrl ? onRetry() : void load(row.url);
												focusTree();
											}}
										>
											<RefreshCw size={12} />
											{t('remoteTree.retry')}
										</button>
									)}
								</div>
							);
						}
						return (
							<div
								id={`${treeId}-${index}`}
								role="treeitem"
								aria-label={row.name}
								aria-level={row.depth + 1}
								aria-posinset={row.position}
								aria-setsize={row.total}
								aria-expanded={row.kind === 'dir' ? expanded.has(row.url) : undefined}
								aria-selected={selectedUrl === row.url}
								aria-busy={loading}
								className={`remote-entry remote-columns ${selectedUrl === row.url ? 'selected' : ''}`}
								data-url={row.url}
								onClick={() => {
									select(row);
									focusTree();
								}}
								onDoubleClick={(event) => {
									if (row.kind === 'dir' && !(event.target as HTMLElement).closest('button')) {
										toggle(row);
									}
								}}
							>
								<div className="remote-tree-name" style={{ paddingLeft: row.depth * 16 }}>
									{row.kind === 'dir' ? (
										<button
											className="tree-disclosure"
											tabIndex={-1}
											aria-label={`${expanded.has(row.url) ? t('fileTreeName.collapse') : t('fileTreeName.expand')} ${row.name}`}
											onClick={(event) => {
												event.stopPropagation();
												select(row);
												toggle(row);
												focusTree();
											}}
										>
											<ChevronRight size={12} className={expanded.has(row.url) ? 'rotated' : ''} />
										</button>
									) : (
										<span className="tree-disclosure-placeholder" />
									)}
									{row.depth === 0 ? <Cloud size={18} className="remote-root-icon" /> : <FileIcon path={row.name} kind={row.kind} />}
									<span className="truncate" title={row.url}>
										{row.name}
									</span>
									{row.depth === 0 && <small className="remote-head">HEAD</small>}
									{loading && (
										<>
											<LoaderCircle size={13} className="spin" aria-label={t('dialogs.connectingToRepository')} />
											<button
												className="remote-row-stop"
												title={t('dialogs.stopConnecting')}
												aria-label={`${t('dialogs.stopConnecting')} ${row.name}`}
												onClick={(event) => {
													event.stopPropagation();
													row.url === rootUrl ? onCancel() : cancel(row.url);
													focusTree();
												}}
											>
												<X size={12} />
											</button>
										</>
									)}
								</div>
								<span className="remote-revision">{row.entry?.revision ? `r${row.entry.revision}` : '—'}</span>
								<span className="truncate">{fmtDate(row.entry?.date)}</span>
								<span className="truncate">{row.entry?.author || '—'}</span>
							</div>
						);
					}}
				/>
			)}
			<span className="sr-only" role="status">
				{pending ? t('remoteTree.loadingCount', { count: pending }) : ''}
			</span>
		</div>
	);
}
