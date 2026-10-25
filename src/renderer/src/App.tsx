import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
	Archive,
	ArrowDownToLine,
	Check,
	CheckCircle2,
	ChevronDown,
	CircleAlert,
	Clock3,
	Cloud,
	Code2,
	Copy,
	EyeOff,
	FileDiff,
	Files,
	Folder,
	FolderGit2,
	GitBranch,
	History,
	Info,
	Keyboard,
	LoaderCircle,
	MoreHorizontal,
	PanelRightClose,
	PanelRightOpen,
	Pencil,
	Plus,
	RefreshCw,
	RotateCcw,
	Search,
	Settings2,
	ShieldCheck,
	Terminal,
	Trash2,
	Upload,
	Wrench,
	X,
} from 'lucide-react';
import {
	emptySession,
	isChanged,
	isConflict,
	type Action,
	type AppState,
	type FileStatus,
	type Filter,
	type LogEntry,
	type Operation,
	type Review,
	type Snapshot,
	type SvnInfo,
	type WorkspaceSession,
} from '../../shared/types';
import { Button } from './components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { api, errorText, Modal, RemoteDialog, ReviewDialog, SettingsDialog } from './components/Dialogs';
import { DiffView } from './components/DiffView';
import { HistoryTimeline } from './components/HistoryTimeline';
import { CommitPanel } from './components/CommitPanel';
import { WorkspaceNavigation } from './components/WorkspaceNavigation';
import { Combobox } from './components/ui/combobox';
import { notifyError, notifyOperation } from './lib/feedback';
import { requestAuthentication } from './lib/authentication';
import { toast } from 'sonner';
import { VirtualList } from './components/VirtualList';
import { FileTreeName } from './components/FileTreeName';
import { FileIcon } from './components/FileIcon';

const statusLabels: Record<string, string> = {
	normal: '正常',
	modified: '修改',
	added: '新增',
	deleted: '删除',
	missing: '缺失',
	unversioned: '未受控',
	ignored: '忽略',
	conflicted: '冲突',
	replaced: '替换',
	external: '外部副本',
	obstructed: '阻塞',
	incomplete: '不完整',
	none: '—',
};
const statusCodes: Record<string, string> = {
	normal: '✓',
	modified: 'M',
	added: 'A',
	deleted: 'D',
	missing: '!',
	unversioned: '?',
	ignored: 'I',
	conflicted: 'C',
	replaced: 'R',
	external: 'X',
	obstructed: '~',
	incomplete: '!',
};
const filters: { value: Filter; label: string }[] = [
	{ value: 'all', label: '全部' },
	{ value: 'modified', label: '修改' },
	{ value: 'added', label: '新增' },
	{ value: 'deleted', label: '删除' },
	{ value: 'unversioned', label: '未受控' },
	{ value: 'ignored', label: '忽略' },
	{ value: 'conflicted', label: '冲突' },
];
const opLabels: Record<Operation['state'], string> = { waiting: '等待中', running: '执行中', success: '已完成', failed: '失败', cancelled: '已取消', uncertain: '结果待核实' };
const fmtDate = (date?: string): string => (date ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '—');

const leaf = (path: string): string => path.split('/').at(-1) || path;

const parent = (path: string): string => (path.includes('/') ? path.split('/').slice(0, -1).join('/') : '');
function fileState(file: FileStatus): string {
	return isConflict(file)
		? 'conflicted'
		: file.copied && ['normal', 'none'].includes(file.item)
			? 'added'
			: file.props === 'modified' && ['normal', 'none'].includes(file.item)
				? 'modified'
				: file.item;
}
function StatusBadge({ file }: { file: FileStatus }) {
	const status = fileState(file);
	return (
		<span
			className={`status-badge ${status}`}
			title={`${statusLabels[status] || status} · 属性 ${statusLabels[file.props] || file.props}${file.copied ? ' · 带历史复制' : ''}${file.treeConflicted ? ' · 树冲突' : ''}`}
		>
			<b>{statusCodes[status] || '·'}</b>
			{statusLabels[status] || status}
			{file.props === 'modified' && <i>属性</i>}
			{file.copied && <i>复制</i>}
			{file.treeConflicted && <i>树</i>}
			{file.external && <i>外部</i>}
		</span>
	);
}

export function App() {
	const [state, setState] = useState<AppState>();
	const stateRef = useRef<AppState | undefined>(undefined);
	const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
	const [loading, setLoading] = useState<Record<string, boolean>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [operations, setOperations] = useState<Operation[]>([]);
	const [modal, setModal] = useState<'settings' | 'remote' | 'commit' | 'group' | 'manage' | null>(null);
	const [remoteId, setRemoteId] = useState<string>();
	const [review, setReview] = useState<Review>();
	const [reviewing, setReviewing] = useState(false);
	const [bootError, setBootError] = useState('');
	const [activeRepositoryId, setActiveRepositoryId] = useState<string>();
	const [remoteUrl, setRemoteUrl] = useState<string>();
	const [remoteLocation, setRemoteLocation] = useState<string>();
	const [previewHidden, setPreviewHidden] = useState(false);
	const [fileSearch, setFileSearch] = useState('');
	const [showDetails, setShowDetails] = useState(true);
	const [showOperations, setShowOperations] = useState(false);
	const [sidebarWidth, setSidebarWidth] = useState(256);
	const [detailsWidth, setDetailsWidth] = useState(250);
	const [listHeight, setListHeight] = useState(300);
	const [diff, setDiff] = useState({ text: '', loading: false, error: '', unsupported: '' });
	const [fileInfo, setFileInfo] = useState<{ info?: SvnInfo; properties?: { name: string; value: string }[]; error?: string; loading?: boolean }>({});
	const [histories, setHistories] = useState<Record<string, LogEntry[]>>({});
	const [historyBusy, setHistoryBusy] = useState<Record<string, boolean>>({});
	const [historyEnd, setHistoryEnd] = useState<Record<string, boolean>>({});
	const [historyErrors, setHistoryErrors] = useState<Record<string, string>>({});
	const [context, setContext] = useState<{ x: number; y: number; path: string }>();
	const [manage, setManage] = useState<{ entity: 'workingCopy' | 'repository' | 'group'; id: string }>();
	const [editName, setEditName] = useState('');
	const [renameTarget, setRenameTarget] = useState<string>();
	const [renameValue, setRenameValue] = useState('');
	const [detected, setDetected] = useState('检测中');
	const fileHeader = useRef<HTMLDivElement>(null);
	const scans = useRef<Record<string, number>>({});
	const historyRequests = useRef<Record<string, number>>({});
	const navigateRef = useRef<(action: string) => void>(() => {});
	const initialized = useRef(false);
	const activeId = state?.activeId;
	const wc = activeRepositoryId ? undefined : state?.workingCopies.find((copy) => copy.id === activeId);
	const activeRepository = state?.repositories.find((repo) => repo.id === activeRepositoryId);
	const session = activeId ? (state?.sessions[activeId] ?? emptySession()) : emptySession();
	const snapshot = activeId ? snapshots[activeId] : undefined;
	const currentFile = snapshot?.files.find((file) => file.path === session.currentPath);
	const historyKey = `${activeId}:${session.historyTarget}`;
	const logs = histories[historyKey];
	const historySearch = session.historySearch ?? '';
	const filteredLogs = useMemo(
		() =>
			(logs ?? []).filter(
				(entry) =>
					!historySearch ||
					`${entry.revision} ${entry.author} ${entry.message} ${entry.paths.map((path) => path.path).join(' ')}`.toLowerCase().includes(historySearch.toLowerCase()),
			),
		[logs, historySearch],
	);
	const selectedLog = filteredLogs.find((entry) => entry.revision === session.historyRevision);
	const busyWrite = operations.some((operation) => operation.wcId === activeId && ['waiting', 'running'].includes(operation.state));
	const changed = snapshot?.files.filter(isChanged) ?? [];
	const commitFiles = changed.filter((file) => !isConflict(file) && !file.external && !['missing', 'obstructed', 'incomplete'].includes(file.item));
	const showPreview =
		session.view !== 'history' &&
		!previewHidden &&
		!!currentFile &&
		(isChanged(currentFile) || (currentFile.kind === 'dir' && changed.some((file) => currentFile.path === '.' || file.path.startsWith(`${currentFile.path}/`))));
	stateRef.current = state;

	const acceptState = useCallback((next: AppState) => {
		stateRef.current = next;
		setState(next);
	}, []);
	const showError = useCallback((error: unknown) => {
		if (!stateRef.current) {
			setBootError(errorText(error));
		}
		notifyError(error);
	}, []);
	const patchSession = useCallback(
		(patch: Partial<WorkspaceSession>, id = stateRef.current?.activeId) => {
			if (!id) {
				return;
			}
			if (patch.view && patch.view !== 'history') {
				patch = { ...patch, lastFileView: patch.view };
			}
			setState((previous) => (previous ? { ...previous, sessions: { ...previous.sessions, [id]: { ...(previous.sessions[id] ?? emptySession()), ...patch } } } : previous));
			void api.call('session', { wcId: id, patch }).catch(showError);
		},
		[showError],
	);

	const refresh = useCallback(
		async (id?: string, remote = false, announce = false) => {
			if (!id) {
				return;
			}
			const request = (scans.current[id] ?? 0) + 1;
			scans.current[id] = request;
			setLoading((previous) => ({ ...previous, [id]: true }));
			setErrors((previous) => ({ ...previous, [id]: '' }));
			try {
				const next = await api.call('status', { wcId: id, remote });
				if (scans.current[id] !== request) {
					return;
				}
				setSnapshots((previous) => ({ ...previous, [id]: next }));
				if (remote) {
					toast.info(`远端检查完成 · ${next.remoteChanges ?? 0} 个路径有变化`, { description: '仅检查远端状态，磁盘文件尚未更新' });
				} else if (announce) {
					toast.success('本地状态已刷新');
				}
				setState((previous) => {
					if (!previous) {
						return previous;
					}
					const valid = next.files.filter(isChanged).map((file) => file.path);
					const saved = previous.sessions[id] ?? emptySession();
					const selected = saved.selected.filter((path) => valid.includes(path));
					const expanded = saved.treeInitialized
						? saved.expanded
						: [
								...new Set([
									...saved.expanded,
									...next.files
										.filter((file) => isChanged(file) || file.item === 'unversioned')
										.flatMap((file) => {
											const dirs: string[] = [];
											let path = parent(file.path);
											while (path) {
												dirs.push(path);
												path = parent(path);
											}
											return dirs;
										}),
								]),
							];
					if (selected.length !== saved.selected.length || !saved.treeInitialized) {
						void api.call('session', { wcId: id, patch: { selected, expanded, treeInitialized: true } }).catch(showError);
					}
					return {
						...previous,
						workingCopies: previous.workingCopies.map((copy) =>
							copy.id === id
								? {
										...copy,
										lastScan: next.scannedAt,
										changeCount: next.files.filter(isChanged).length,
										conflicts: next.files.filter(isConflict).length,
										error: undefined,
									}
								: copy,
						),
						sessions: { ...previous.sessions, [id]: { ...saved, selected, expanded, treeInitialized: true } },
					};
				});
			} catch (error) {
				if (scans.current[id] === request) {
					const text = errorText(error);
					setErrors((previous) => ({ ...previous, [id]: text }));
					if (announce || remote) {
						notifyError(error);
					}
					setState((previous) =>
						previous ? { ...previous, workingCopies: previous.workingCopies.map((copy) => (copy.id === id ? { ...copy, error: text } : copy)) } : previous,
					);
				}
			} finally {
				if (scans.current[id] === request) {
					setLoading((previous) => ({ ...previous, [id]: false }));
				}
			}
		},
		[showError],
	);

	useEffect(() => {
		const changed = (event: Event) => {
			const next = (event as CustomEvent<AppState>).detail;
			setState((previous) =>
				previous
					? {
							...previous,
							credentials: next.credentials,
							repositories: previous.repositories.map((repo) => ({ ...repo, credentialId: next.repositories.find((item) => item.id === repo.id)?.credentialId })),
						}
					: previous,
			);
		};
		window.addEventListener('svnbox:authentication-changed', changed);
		return () => window.removeEventListener('svnbox:authentication-changed', changed);
	}, []);

	useEffect(() => {
		void api.call('state', undefined).then(acceptState).catch(showError);
		void api.call('operations', undefined).then(setOperations).catch(showError);
		void api
			.call('detect', {})
			.then((result) => setDetected(result.ok ? `SVN ${result.version}` : 'SVN 未配置'))
			.catch(() => setDetected('SVN 未配置'));
		const unsubscribe = api.onOperation((operation) => {
			const project = stateRef.current?.workingCopies.find((copy) => copy.id === operation.wcId)?.name ?? '远端仓库';
			notifyOperation(operation, project, () => setShowOperations(true));
			setOperations((previous) => [operation, ...previous.filter((item) => item.id !== operation.id)].slice(0, 100));
			if (!['running', 'waiting'].includes(operation.state)) {
				if (operation.wcId) {
					void refresh(operation.wcId);
				}
				if (operation.state === 'success') {
					void api
						.call('state', undefined)
						.then((next) => {
							setState((previous) => {
								if (!previous) {
									return next;
								}
								const sessions = { ...previous.sessions };
								if (operation.label === '提交变更' && operation.wcId) {
									const saved = next.sessions[operation.wcId];
									const local = sessions[operation.wcId];
									if (saved && local) {
										sessions[operation.wcId] = {
											...local,
											draft: next.recentMessages[0] === local.draft ? saved.draft : local.draft,
											selected: local.selected.filter((path) => saved.selected.includes(path)),
										};
									}
								}
								for (const [id, saved] of Object.entries(next.sessions)) {
									sessions[id] ??= saved;
								}
								return { ...next, activeId: previous.activeId || next.activeId, sessions };
							});
						})
						.catch(showError);
					if (operation.wcId) {
						setHistories((previous) => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${operation.wcId}:`))));
					}
				}
			}
		});
		const unsubscribeMenu = api.onNavigate((action) => navigateRef.current(action));
		return () => {
			unsubscribe();
			unsubscribeMenu();
		};
	}, [acceptState, refresh, showError]);

	useEffect(() => {
		if (state && !initialized.current) {
			initialized.current = true;
			for (const copy of state.workingCopies) {
				void refresh(copy.id);
			}
		}
	}, [state, refresh]);
	useEffect(() => {
		if (activeId && !snapshots[activeId] && !loading[activeId] && !errors[activeId]) {
			void refresh(activeId);
		}
	}, [activeId, snapshots, loading, errors, refresh]);
	useEffect(() => {
		if (!state) {
			return;
		}
		const media = matchMedia('(prefers-color-scheme: dark)');
		const apply = () => {
			document.documentElement.classList.toggle('dark', state.settings.theme === 'dark' || (state.settings.theme === 'system' && media.matches));
		};
		apply();
		media.addEventListener('change', apply);
		return () => media.removeEventListener('change', apply);
	}, [state?.settings.theme]);

	const loadHistory = useCallback(async (id: string, target: string, before?: number) => {
		const key = `${id}:${target}`;
		const request = (historyRequests.current[key] ?? 0) + 1;
		historyRequests.current[key] = request;
		setHistoryBusy((previous) => ({ ...previous, [key]: true }));
		setHistoryErrors((previous) => ({ ...previous, [key]: '' }));
		try {
			const result = await api.call('log', { wcId: id, path: target, before });
			if (historyRequests.current[key] !== request) {
				return;
			}
			setHistories((previous) => ({
				...previous,
				[key]: before === undefined ? result : [...(previous[key] ?? []), ...result.filter((entry) => !previous[key]?.some((old) => old.revision === entry.revision))],
			}));
			setHistoryEnd((previous) => ({ ...previous, [key]: result.length < 50 || result.at(-1)?.revision === 0 }));
		} catch (error) {
			if (historyRequests.current[key] === request) {
				setHistoryErrors((previous) => ({ ...previous, [key]: errorText(error) }));
			}
		} finally {
			if (historyRequests.current[key] === request) {
				setHistoryBusy((previous) => ({ ...previous, [key]: false }));
			}
		}
	}, []);
	useEffect(() => {
		if (activeId && session.view === 'history' && !logs && !historyBusy[historyKey] && !historyErrors[historyKey]) {
			void loadHistory(activeId, session.historyTarget);
		}
	}, [activeId, session.view, session.historyTarget, logs, historyBusy, historyKey, historyErrors, loadHistory]);

	useEffect(() => {
		let current = true;
		if (!activeId || !session.currentPath || session.view === 'history') {
			setDiff({ text: '', loading: false, error: '', unsupported: '' });
			return;
		}
		setDiff({ text: '', loading: true, error: '', unsupported: '' });
		void api
			.call('diff', {
				wcId: activeId,
				path: session.currentPath,
			})
			.then((result) => {
				if (current) {
					setDiff({ text: result.text, loading: false, error: '', unsupported: result.unsupported ?? '' });
				}
			})
			.catch((error) => {
				if (current) {
					setDiff({ text: '', loading: false, error: errorText(error), unsupported: '' });
				}
			});
		return () => {
			current = false;
		};
	}, [activeId, session.currentPath, session.view, snapshot?.scannedAt]);
	useEffect(() => {
		let current = true;
		if (!activeId || !session.currentPath || session.view === 'history') {
			setFileInfo({});
			return;
		}
		setFileInfo({ loading: true });
		void Promise.allSettled([api.call('info', { wcId: activeId, path: session.currentPath }), api.call('properties', { wcId: activeId, path: session.currentPath })]).then(
			([info, props]) => {
				if (current) {
					setFileInfo({
						loading: false,
						info: info.status === 'fulfilled' ? info.value : undefined,
						properties: props.status === 'fulfilled' ? props.value : undefined,
						error: info.status === 'rejected' ? errorText(info.reason) : props.status === 'rejected' ? errorText(props.reason) : undefined,
					});
				}
			},
		);
		return () => {
			current = false;
		};
	}, [activeId, session.currentPath, session.view, snapshot?.scannedAt]);

	async function authenticate(url: string, repositoryId?: string) {
		try {
			await requestAuthentication(await api.call('authentication', { url, repositoryId }));
		} catch (error) {
			showError(error);
		}
	}

	async function addWorkingCopy() {
		try {
			const path = await api.call('pickFolder', undefined);
			if (!path) {
				return;
			}
			const next = await api.call('addWorkingCopy', { path });
			acceptState(next);
			setActiveRepositoryId(undefined);
			toast.success('工作副本已添加');
			if (next.activeId) {
				void refresh(next.activeId);
			}
		} catch (error) {
			showError(error);
		}
	}
	function activate(id: string) {
		setActiveRepositoryId(undefined);
		setRemoteUrl(undefined);
		setRemoteLocation(undefined);
		setState((previous) => (previous ? { ...previous, activeId: id } : previous));
		setFileSearch('');
		void api.call('activate', { wcId: id }).catch(showError);
	}
	async function requestReview(action: Action, paths = session.selected, destination?: string) {
		if (!activeId) {
			return;
		}
		setReviewing(true);
		try {
			const next = await api.call('review', { wcId: activeId, action, paths, destination, message: action === 'commit' ? session.draft : undefined });
			setReview(next);
			if (action === 'commit') {
				setModal(null);
			}
			setRenameTarget(undefined);
		} catch (error) {
			showError(error);
		} finally {
			setReviewing(false);
		}
	}
	async function executeReview() {
		if (!review) {
			return;
		}
		try {
			await api.call('execute', { reviewId: review.id });
			setReview(undefined);
			setModal(null);
		} catch (error) {
			showError(error);
			setReview(undefined);
		}
	}
	function openManage(entity: 'workingCopy' | 'repository' | 'group', id: string, name: string) {
		setManage({ entity, id });
		setEditName(name);
		setModal('manage');
	}
	function openRemote(id?: string, url?: string) {
		if (id) {
			setActiveRepositoryId(id);
			setRemoteUrl(url);
			setRemoteLocation(url ?? stateRef.current?.repositories.find((repo) => repo.id === id)?.rootUrl);
			setModal(null);
		} else {
			setRemoteId(undefined);
			setModal('remote');
		}
	}

	async function updateCopy() {
		if (!wc) {
			return;
		}
		try {
			const next = await api.call('review', { wcId: wc.id, action: 'update', paths: [] });
			await api.call('execute', { reviewId: next.id });
		} catch (error) {
			showError(error);
		}
	}

	async function compareFile(path: string, revision?: number) {
		if (!activeId) {
			return;
		}
		try {
			await api.call('compare', { wcId: activeId, path, revision });
			toast.success('已在 FileMerge 中打开比较');
		} catch (error) {
			showError(error);
		}
	}

	function openCommit(paths?: string[]) {
		if (!wc) {
			return;
		}
		if (paths) {
			patchSession({ selected: paths });
		}
		setModal('commit');
	}

	useEffect(() => {
		setPreviewHidden(false);
	}, [activeId, session.currentPath, session.view, session.historyRevision]);

	function resize(event: ReactPointerEvent, kind: 'sidebar' | 'details' | 'list') {
		if (event.button !== 0) {
			return;
		}
		const start = kind === 'list' ? event.clientY : event.clientX;
		const width = kind === 'sidebar' ? sidebarWidth : kind === 'details' ? detailsWidth : listHeight;
		event.currentTarget.setPointerCapture(event.pointerId);
		const move = (next: PointerEvent) => {
			const delta = (kind === 'list' ? next.clientY : next.clientX) - start;
			if (kind === 'sidebar') {
				setSidebarWidth(Math.min(380, Math.max(204, width + delta)));
			} else if (kind === 'details') {
				setDetailsWidth(Math.min(410, Math.max(220, width - delta)));
			} else {
				setListHeight(Math.min(650, Math.max(150, width + delta)));
			}
		};
		const stop = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', stop);
			window.removeEventListener('pointercancel', stop);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', stop);
		window.addEventListener('pointercancel', stop);
	}
	navigateRef.current = (action) => {
		if (action === 'settings') {
			setModal('settings');
		} else if (action === 'add') {
			void addWorkingCopy();
		} else if (action === 'remote') {
			openRemote();
		} else if (action === 'refresh') {
			void refresh(activeId, false, true);
		} else if (action === 'commit' && wc) {
			setModal('commit');
		} else if (action === 'update' && wc) {
			void updateCopy();
		} else if (['changes', 'files', 'history'].includes(action)) {
			patchSession({ view: action as WorkspaceSession['view'] });
		} else if (action === 'operations') {
			setShowOperations((value) => !value);
		}
	};
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setContext(undefined);
			}
		};
		window.addEventListener('keydown', key);
		return () => window.removeEventListener('keydown', key);
	}, []);

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

	function navigateList(event: React.KeyboardEvent<HTMLDivElement>) {
		const target = event.target as HTMLElement;
		if (target.matches('input,textarea,select') || modal || review || session.view === 'history') {
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
			setPreviewHidden((value) => !value);
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

	function fileActions(path: string) {
		const file = snapshot?.files.find((item) => item.path === path);
		const canEdit = !!file && !['unversioned', 'ignored', 'external', 'deleted', 'missing'].includes(file.item) && path !== '.';
		const groups = [
			[
				<DropdownMenuItem
					key="diff"
					icon={<FileDiff />}
					onSelect={() => {
						patchSession({ currentPath: path });
						setPreviewHidden(false);
					}}
				>
					查看内置差异
				</DropdownMenuItem>,
				file?.kind === 'file' && (
					<DropdownMenuItem key="compare" icon={<Files />} onSelect={() => void compareFile(path)}>
						在 FileMerge 中比较
					</DropdownMenuItem>
				),
				<DropdownMenuItem
					key="history"
					icon={<History />}
					onSelect={() => {
						patchSession({ view: 'history', historyTarget: path, historyDiffPath: path, historyRevision: undefined });
					}}
				>
					查看此路径历史
				</DropdownMenuItem>,
			],
			[
				file && isChanged(file) && !isConflict(file) && (
					<DropdownMenuItem key="commit" icon={<Upload />} onSelect={() => openCommit([path])}>
						提交此路径…
					</DropdownMenuItem>
				),
				file?.item === 'unversioned' && (
					<DropdownMenuItem key="add" icon={<Plus />} onSelect={() => void requestReview('add', [path])}>
						加入版本控制…
					</DropdownMenuItem>
				),
				file?.item === 'unversioned' && (
					<DropdownMenuItem key="ignore" icon={<EyeOff />} onSelect={() => void requestReview('ignore', [path])}>
						忽略此名称…
					</DropdownMenuItem>
				),
				canEdit && (
					<DropdownMenuItem
						key="rename"
						icon={<Pencil />}
						onSelect={() => {
							setRenameTarget(path);
							setRenameValue(path);
						}}
					>
						重命名 / 移动…
					</DropdownMenuItem>
				),
			],
			[
				file && isConflict(file) && (
					<DropdownMenuItem
						key="merge"
						icon={<Code2 />}
						onSelect={() => {
							void api.call('system', { wcId: activeId!, path, action: 'merge' }).catch(showError);
						}}
					>
						用外部合并工具打开
					</DropdownMenuItem>
				),
				file && isConflict(file) && (
					<DropdownMenuItem key="check" icon={<RefreshCw />} onSelect={() => void refresh(activeId)}>
						检查解决结果
					</DropdownMenuItem>
				),
				file && isConflict(file) && (
					<DropdownMenuItem key="resolve" icon={<CheckCircle2 />} onSelect={() => void requestReview('resolve', [path])}>
						接受当前文件并标记已解决…
					</DropdownMenuItem>
				),
			],
			[
				<DropdownMenuItem
					key="reveal"
					icon={<Folder />}
					onSelect={() => {
						void api.call('system', { wcId: activeId!, path, action: 'reveal' }).catch(showError);
					}}
				>
					在 Finder 中显示
				</DropdownMenuItem>,
				<DropdownMenuItem
					key="copy"
					icon={<Copy />}
					onSelect={() => {
						void api.call('system', { wcId: activeId!, path, action: 'copy' }).catch(showError);
					}}
				>
					复制绝对路径
				</DropdownMenuItem>,
				<DropdownMenuItem
					key="terminal"
					icon={<Terminal />}
					onSelect={() => {
						void api.call('system', { wcId: activeId!, path, action: 'terminal' }).catch(showError);
					}}
				>
					在终端中打开
				</DropdownMenuItem>,
			],
			[
				file && isChanged(file) && (
					<DropdownMenuItem key="revert" icon={<RotateCcw />} destructive onSelect={() => void requestReview('revert', [path])}>
						{path === '.' ? '还原整个副本的变更…' : '还原变更…'}
					</DropdownMenuItem>
				),
				canEdit && (
					<DropdownMenuItem key="delete" icon={<Trash2 />} destructive onSelect={() => void requestReview('delete', [path])}>
						删除磁盘内容并安排 SVN 删除…
					</DropdownMenuItem>
				),
			],
		]
			.map((items) => items.filter(Boolean))
			.filter((items) => items.length > 0);
		return groups.map((items, index) => (
			<Fragment key={index}>
				{index > 0 && <DropdownMenuSeparator />}
				<DropdownMenuGroup>{items}</DropdownMenuGroup>
			</Fragment>
		));
	}

	if (!state) {
		return (
			<div className="boot">
				<Archive size={40} />
				<h1>仓盒</h1>
				<p>正在载入本地工作空间…</p>
				{bootError && <pre className="inline-error">{bootError}</pre>}
			</div>
		);
	}
	const activeOps = operations.filter((operation) => ['running', 'waiting'].includes(operation.state));
	const currentError = activeId ? errors[activeId] : '';
	return (
		<div className="app-shell" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
			<header className="titlebar">
				<div className="titlebar-sidebar">
					<div className="traffic-space" />
				</div>
				{wc ? (
					<div className="project-header">
						<div className="project-heading">
							<FolderGit2 size={19} />
							<div>
								<h1>{wc.name}</h1>
								<div className="project-path" title={`${wc.path}\n${wc.url}`}>
									{wc.path}
								</div>
							</div>
						</div>
						<div className="project-actions">
							<Button
								variant="ghost"
								size="icon"
								aria-label="刷新本地状态"
								title="刷新本地状态 · ⌘R"
								disabled={!!loading[wc.id]}
								onClick={() => void refresh(wc.id, false, true)}
							>
								<RefreshCw className={loading[wc.id] ? 'spin' : ''} />
							</Button>
							<Button variant="outline" disabled={busyWrite || reviewing} onClick={() => void updateCopy()}>
								<ArrowDownToLine />
								更新
							</Button>
							<Button disabled={busyWrite || reviewing || !snapshot || !commitFiles.length} onClick={() => openCommit()}>
								<Upload />
								提交…<span className="button-count">{commitFiles.length}</span>
							</Button>
						</div>
					</div>
				) : (
					<div className="window-title">
						<strong>{activeRepository?.name ?? '工作空间'}</strong>
						<span>{activeRepository?.rootUrl ?? 'svnbox'}</span>
					</div>
				)}
				<Button variant="ghost" size="icon" aria-label="切换详情面板" title="切换详情面板" onClick={() => setShowDetails((value) => !value)}>
					{showDetails ? <PanelRightClose /> : <PanelRightOpen />}
				</Button>
			</header>
			<div
				className="sidebar-resizer"
				role="separator"
				aria-label="调整导航宽度"
				aria-orientation="vertical"
				aria-valuemin={204}
				aria-valuemax={380}
				aria-valuenow={sidebarWidth}
				tabIndex={0}
				onPointerDown={(event) => resize(event, 'sidebar')}
				onKeyDown={(event) => {
					if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
						return;
					}
					event.preventDefault();
					setSidebarWidth((width) =>
						event.key === 'Home' ? 204 : event.key === 'End' ? 380 : Math.min(380, Math.max(204, width + (event.key === 'ArrowRight' ? 8 : -8))),
					);
				}}
			/>
			<div className="workspace">
				<aside className="sidebar">
					<WorkspaceNavigation
						state={state}
						activeId={activeId}
						activeRepositoryId={activeRepositoryId}
						activeUrl={remoteLocation}
						operations={operations}
						onState={acceptState}
						onActivate={activate}
						onRemote={openRemote}
						onAuthenticate={(url, id) => void authenticate(url, id)}
						onAddCopy={() => void addWorkingCopy()}
						onGroup={() => {
							setEditName('');
							setModal('group');
						}}
						onManage={openManage}
						onRefresh={(id) => void refresh(id, false, true)}
					/>
					<div className="sidebar-bottom">
						<button onClick={() => setShowOperations((value) => !value)} className={showOperations ? 'selected' : ''}>
							<Clock3 size={15} />
							<span>操作记录</span>
							{activeOps.length > 0 ? <span className="nav-count">{activeOps.length}</span> : <kbd>⌘J</kbd>}
						</button>
						<button onClick={() => setModal('settings')}>
							<Settings2 size={15} />
							<span>设置</span>
							<kbd>⌘,</kbd>
						</button>
					</div>
				</aside>
				<div className="sidebar-divider" aria-hidden="true" />
				<main className="main-area">
					{wc ? (
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
										{loading[wc.id]
											? '正在扫描…'
											: `本地扫描 ${snapshot ? new Date(snapshot.scannedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '尚未扫描'}`}
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
									<div
										className="file-pane"
										onScrollCapture={(event) => {
											const target = event.target as HTMLElement;
											if (fileHeader.current && target.classList.contains('virtual-list')) {
												fileHeader.current.scrollLeft = target.scrollLeft;
											}
										}}
										style={showPreview ? { height: listHeight } : undefined}
										tabIndex={0}
										aria-label="文件与历史列表，方向键浏览，空格选择，Shift F10 打开菜单"
										onKeyDown={navigateList}
									>
										{session.view === 'history' ? (
											<>
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
														aria-busy={historyBusy[historyKey] || undefined}
														disabled={historyBusy[historyKey]}
														onClick={() => void loadHistory(wc.id, session.historyTarget)}
													>
														<RefreshCw className={historyBusy[historyKey] ? 'spin' : ''} />
														{historyBusy[historyKey] ? '刷新中' : '刷新'}
													</Button>
												</div>
												{historyErrors[historyKey] ? (
													<div className="empty error-text">
														<CircleAlert />
														{historyErrors[historyKey]}
														<Button variant="outline" onClick={() => void loadHistory(wc.id, session.historyTarget)}>
															重试
														</Button>
													</div>
												) : !logs && historyBusy[historyKey] ? (
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
														repositoryRoot={state.repositories.find((repo) => repo.id === wc.repositoryId)?.rootUrl ?? wc.url}
														onChange={patchSession}
														onCompare={(path, revision) => void compareFile(path, revision)}
													/>
												)}
												<div className="list-footer">
													<span>已加载 {logs?.length ?? 0} 条 · 输入框仅筛选已加载记录</span>
													<Button
														variant="ghost"
														size="sm"
														disabled={historyBusy[historyKey] || historyEnd[historyKey] || !logs?.length}
														onClick={() => void loadHistory(wc.id, session.historyTarget, (logs?.at(-1)?.revision ?? 1) - 1)}
													>
														{historyBusy[historyKey] && <LoaderCircle className="spin" />}
														{historyEnd[historyKey] ? '已到历史起点' : '从服务器加载更早记录'}
													</Button>
												</div>
											</>
										) : (
											<>
												<div className="workspace-toolbar filter-toolbar">
													<label className="changed-toggle">
														<input
															type="checkbox"
															aria-label="仅显示变更"
															checked={session.view === 'changes'}
															onChange={(event) => patchSession({ view: event.target.checked ? 'changes' : 'files', filter: 'all' })}
														/>
														仅显示变更
													</label>
													<div className="filter-buttons" role="group" aria-label="文件状态筛选">
														{filters.map((filter) => (
															<button
																className={session.filter === filter.value ? 'active' : ''}
																key={filter.value}
																onClick={() => patchSession({ filter: filter.value })}
															>
																{filter.label}
																{filter.value === 'conflicted' && snapshot?.files.some(isConflict) && <span className="conflict-dot" />}
															</button>
														))}
													</div>
													<div className="inline-search">
														<Search size={12} />
														<input
															aria-label="搜索文件"
															placeholder="筛选路径…"
															value={fileSearch}
															onChange={(event) => setFileSearch(event.target.value)}
														/>
													</div>
												</div>
												<div className="file-table-header" ref={fileHeader}>
													<div className="table-head file-columns" style={{ minWidth: fileListMinWidth }}>
														<span>
															名称 <ChevronDown size={10} />
														</span>
														<span>状态</span>
														<span>版本</span>
														<span>作者</span>
													</div>
												</div>
												{loading[wc.id] && !snapshot ? (
													<div className="empty">
														<LoaderCircle className="spin" />
														扫描工作副本
													</div>
												) : !visibleFiles.length ? (
													<div className="empty">
														<CheckCircle2 size={30} />
														<strong>{snapshot && !changed.length && !fileSearch ? '工作副本干净' : '没有匹配的文件'}</strong>
														<span>{snapshot ? '本地状态已检查；可检查远端变化或切换筛选' : '刷新以读取本地状态'}</span>
													</div>
												) : (
													<VirtualList
														items={visibleFiles}
														activeIndex={visibleFiles.findIndex((file) => file.path === session.currentPath)}
														label="工作副本文件"
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
																			expanded: session.expanded.includes(file.path)
																				? session.expanded.filter((path) => path !== file.path)
																				: [...session.expanded, file.path],
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
																		<span className="folder-changes">包含变更</span>
																	) : fileState(file) === 'normal' || fileState(file) === 'none' ? (
																		<span className="normal-file-state" aria-label="无本地修改">
																			—
																		</span>
																	) : (
																		<StatusBadge file={file} />
																	)}
																</span>
																<span className="mono muted file-revision">
																	{file.revision && file.revision !== '-1' ? `r${file.revision}` : '—'}
																</span>
																<div className="row-author">
																	<span className="truncate muted">{file.author || '—'}</span>
																	<DropdownMenu>
																		<DropdownMenuTrigger asChild>
																			<button className="row-more" aria-label={`操作 ${file.path}`}>
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
														{visibleFiles.length} 个路径<span className="separator-dot">·</span>
														{changed.length} 项变更{snapshot?.files.some((file) => file.external) && ' · 外部副本独立管理'}
													</span>
													<span>选择文件查看详情 · 提交时选择范围</span>
												</div>
											</>
										)}
									</div>
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
											<DiffView
												{...diff}
												onClose={() => setPreviewHidden(true)}
												onCompare={currentFile?.kind === 'file' ? () => void compareFile(session.currentPath) : undefined}
												title={session.currentPath || '差异预览'}
											/>
										</>
									)}
									{session.view !== 'history' && !!session.draft && (
										<div className="draft-bar">
											<div>
												<span className="draft-icon">
													<Code2 size={15} />
												</span>
												<strong>提交草稿</strong>
												<span className="draft-preview">{session.draft ? session.draft.split('\n')[0] : '写下本次变更的目的…'}</span>
											</div>
											<Button variant="ghost" size="sm" onClick={() => openCommit()}>
												{session.draft ? '继续编辑' : '编写说明'}
												<kbd>⌘↵</kbd>
											</Button>
										</div>
									)}
								</div>
								{showDetails && (
									<>
										<div
											className="resizer"
											role="separator"
											aria-label="调整详情宽度"
											aria-orientation="vertical"
											onPointerDown={(event) => resize(event, 'details')}
										/>
										<aside className="details-panel" style={{ width: detailsWidth }}>
											<div className="details-title">
												<Info size={13} />
												{session.view === 'history' ? '提交详情' : '文件详情'}
												<button aria-label="收起详情" onClick={() => setShowDetails(false)}>
													<X size={13} />
												</button>
											</div>
											{session.view === 'history' && selectedLog ? (
												<>
													<div className="detail-file-icon">
														<History size={27} />
													</div>
													<h2>版本 r{selectedLog.revision}</h2>
													<p className="detail-subtitle">{selectedLog.author || '未知作者'}</p>
													<dl>
														<dt>提交日期</dt>
														<dd>{fmtDate(selectedLog.date)}</dd>
													</dl>
													<div className="detail-section-title">提交说明</div>
													<pre className="commit-message">{selectedLog.message || '（无提交说明）'}</pre>
													<div className="detail-section-title">变更范围</div>
													<dl>
														<dt>全部路径</dt>
														<dd>{selectedLog.paths.length}</dd>
														{[
															['A', '新增'],
															['M', '修改'],
															['D', '删除'],
															['R', '替换'],
														].map(([action, label]) => (
															<Fragment key={action}>
																<dt>{label}</dt>
																<dd>{selectedLog.paths.filter((path) => path.action === action).length}</dd>
															</Fragment>
														))}
													</dl>
												</>
											) : session.currentPath && session.view !== 'history' ? (
												<>
													<div className="detail-file-icon">
														<FileIcon path={session.currentPath} kind={currentFile?.kind} size={32} />
													</div>
													<h2>{session.currentPath === '.' ? wc.name : leaf(session.currentPath)}</h2>
													<p className="detail-subtitle">{currentFile ? <StatusBadge file={currentFile} /> : '状态待刷新'}</p>
													{fileInfo.loading && (
														<div className="details-loading">
															<LoaderCircle className="spin" size={13} />
															读取 SVN 信息…
														</div>
													)}
													<dl>
														<dt>相对路径</dt>
														<dd className="break-all">{session.currentPath}</dd>
														<dt>版本</dt>
														<dd className="mono">{fileInfo.info?.revision ? `r${fileInfo.info.revision}` : currentFile?.revision || '—'}</dd>
														<dt>最后作者</dt>
														<dd>{currentFile?.author || '—'}</dd>
														<dt>最后修改</dt>
														<dd>{fmtDate(currentFile?.date)}</dd>
														<dt>文件类型</dt>
														<dd>{currentFile?.kind === 'dir' ? '目录' : currentFile?.kind === 'symlink' ? '符号链接' : '文件'}</dd>
														{fileInfo.info?.url && (
															<>
																<dt>仓库 URL</dt>
																<dd className="break-all">{fileInfo.info.url}</dd>
															</>
														)}
														{currentFile?.movedFrom && (
															<>
																<dt>移动来源</dt>
																<dd>{currentFile.movedFrom}</dd>
															</>
														)}
														{currentFile?.movedTo && (
															<>
																<dt>移动目标</dt>
																<dd>{currentFile.movedTo}</dd>
															</>
														)}
													</dl>
													{currentFile && isConflict(currentFile) && (
														<div className="conflict-box">
															<strong>
																<CircleAlert size={14} />
																冲突需要处理
															</strong>
															<p>
																{currentFile.treeConflicted
																	? '树冲突：请核实删除、移动与上游目录结构。'
																	: currentFile.props === 'conflicted'
																		? '属性冲突：请检查并手动修正冲突属性。'
																		: '文本冲突：请在外部工具中合并并保存。'}
															</p>
															{fileInfo.info?.conflicts.length ? <pre>{JSON.stringify(fileInfo.info.conflicts, null, 2)}</pre> : null}
															<Button
																variant="outline"
																size="sm"
																onClick={() => {
																	void api.call('system', { wcId: wc.id, path: session.currentPath, action: 'merge' }).catch(showError);
																}}
															>
																打开合并工具
															</Button>
															<Button variant="outline" size="sm" onClick={() => void refresh(wc.id)}>
																检查解决结果
															</Button>
															<Button size="sm" variant="outline" onClick={() => void requestReview('resolve', [session.currentPath])}>
																标记已解决…
															</Button>
														</div>
													)}
													<div className="detail-section-title">
														SVN 属性<span>{fileInfo.properties?.length ?? '—'}</span>
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
															{fileInfo.loading ? '正在读取…' : fileInfo.error ? '此路径暂无可读取的 SVN 属性' : '未设置自定义属性'}
														</p>
													)}
													{fileInfo.error && (
														<details className="detail-error">
															<summary>查看读取信息</summary>
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
															<Folder />在 Finder 中显示
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
															查看历史
														</Button>
													</div>
												</>
											) : (
												<div className="details-empty">
													<Info size={27} />
													<strong>未选择文件</strong>
													<p>
														选择{session.view === 'history' ? '一条提交记录' : '文件或目录'}查看
														{session.view === 'history' ? '说明及变更路径' : '状态、版本与 SVN 属性'}
													</p>
												</div>
											)}
										</aside>
									</>
								)}
							</div>
						</>
					) : activeRepository ? (
						<RemoteDialog
							key={`${activeRepository.id}:${remoteUrl ?? ''}`}
							embedded
							state={state}
							initialRepositoryId={activeRepository.id}
							initialUrl={remoteUrl}
							onLocationChange={setRemoteLocation}
							onRepositoryChange={openRemote}
							onState={acceptState}
							onClose={() => setActiveRepositoryId(undefined)}
						/>
					) : (
						<div className="welcome">
							<div className="welcome-symbol">
								<Archive size={44} />
							</div>
							<div className="eyebrow">SVNBOX · 仓盒</div>
							<h1>每个项目，都有自己的位置。</h1>
							<p>
								把仓库与工作副本收进仓盒。
								<br />
								清晰审阅变更，从容提交每一个版本。
							</p>
							<div className="welcome-buttons">
								<Button onClick={() => void addWorkingCopy()}>
									<Plus />
									添加已有工作副本
								</Button>
								<Button variant="outline" onClick={() => openRemote()}>
									<Cloud />
									浏览仓库与检出
								</Button>
							</div>
							<div className="welcome-features">
								<span>
									<FolderGit2 />
									多副本独立管理
								</span>
								<span>
									<FileDiff />
									文本与属性差异
								</span>
								<span>
									<ShieldCheck />
									提交前范围审阅
								</span>
							</div>
							<div className="welcome-shortcut">
								<Keyboard size={14} />
								⌘O 添加工作副本<span>·</span>⌘1–3 切换视图<span>·</span>⌘↵ 提交
							</div>
						</div>
					)}
				</main>
			</div>
			<footer className="statusbar">
				<div>
					<span className="local-dot" />
					{detected}
					<span className="status-divider" />
					{wc ? `${wc.depth === 'infinity' ? '完整深度' : wc.depth} · ${state.workingCopies.length} 个工作副本` : '准备就绪'}
				</div>
				<button onClick={() => setShowOperations((value) => !value)}>
					{activeOps.length > 0 ? (
						<>
							<LoaderCircle size={11} className="spin" />
							{activeOps.length} 项操作执行中
						</>
					) : (
						<>
							<Check size={12} />
							就绪
						</>
					)}
					<ChevronDown size={11} />
				</button>
			</footer>
			{context && (
				<DropdownMenu
					open
					onOpenChange={(open) => {
						if (!open) {
							setContext(undefined);
						}
					}}
				>
					<DropdownMenuTrigger style={{ position: 'fixed', left: context.x, top: context.y, width: 1, height: 1 }} />
					<DropdownMenuContent side="bottom" align="start">
						{fileActions(context.path)}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			{modal === 'settings' && <SettingsDialog state={state} onState={acceptState} onClose={() => setModal(null)} />}
			{modal === 'remote' && <RemoteDialog state={state} initialRepositoryId={remoteId} onState={acceptState} onClose={() => setModal(null)} />}
			{modal === 'commit' && wc && (
				<CommitPanel
					key={wc.id}
					copy={wc}
					session={session}
					files={commitFiles}
					recentMessages={state.recentMessages}
					blocked={changed.length - commitFiles.length}
					busy={reviewing || busyWrite}
					scannedAt={snapshot?.scannedAt}
					onPatch={patchSession}
					onReview={(paths) => void requestReview('commit', paths)}
					onClose={() => setModal(null)}
				/>
			)}

			{review && (
				<ReviewDialog
					review={review}
					onClose={() => {
						if (review.action === 'commit') {
							setModal('commit');
						}
						setReview(undefined);
					}}
					onExecute={executeReview}
				/>
			)}
			{(modal === 'group' || modal === 'manage') && (
				<Modal title={modal === 'group' ? '新建分组' : '管理记录'} description="管理记录只影响仓盒列表。移除记录不会删除磁盘内容。" onClose={() => setModal(null)}>
					<label>
						名称
						<input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} />
					</label>
					{modal === 'manage' && manage?.entity !== 'group' && (
						<label>
							所属分组
							<Combobox
								label="所属分组"
								value={(manage?.entity === 'workingCopy' ? state.workingCopies : state.repositories).find((item) => item.id === manage?.id)?.groupId ?? ''}
								options={[{ value: '', label: '未分组' }, ...state.groups.map((group) => ({ value: group.id, label: group.name }))]}
								onValueChange={(groupId) => {
									void api
										.call('manage', { ...manage!, groupId })
										.then(acceptState)
										.catch(showError);
								}}
							/>
						</label>
					)}
					{modal === 'manage' && manage?.entity === 'repository' && (
						<Button
							variant="outline"
							onClick={() => {
								const repo = state.repositories.find((repo) => repo.id === manage.id);
								if (repo) {
									setModal(null);
									void authenticate(repo.rootUrl, repo.id);
								}
							}}
						>
							此连接的认证…
						</Button>
					)}
					{manage?.entity === 'workingCopy' && <p className="hint break-all">{state.workingCopies.find((copy) => copy.id === manage.id)?.path}</p>}
					<div className="dialog-footer">
						{modal === 'manage' && manage && (
							<Button
								variant="ghost"
								className="danger-text mr-auto"
								onClick={() => {
									void api
										.call('manage', { ...manage, remove: true })
										.then((next) => {
											acceptState(next);
											toast.success('管理记录已更新');
											setModal(null);
										})
										.catch(showError);
								}}
							>
								<Trash2 />
								移除管理记录
							</Button>
						)}
						<Button variant="outline" onClick={() => setModal(null)}>
							取消
						</Button>
						<Button
							disabled={!editName.trim()}
							onClick={() => {
								void api
									.call('manage', modal === 'group' ? { entity: 'group', name: editName } : { ...manage!, name: editName })
									.then((next) => {
										acceptState(next);
										setModal(null);
									})
									.catch(showError);
							}}
						>
							保存
						</Button>
					</div>
				</Modal>
			)}
			{renameTarget && (
				<Modal title="重命名 / 移动" description="输入工作副本内的相对目标路径，保留 SVN 历史。目标必须不存在。" onClose={() => setRenameTarget(undefined)}>
					<p className="hint">来源：{renameTarget}</p>
					<label>
						目标相对路径
						<input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
					</label>
					<div className="dialog-footer">
						<Button variant="outline" onClick={() => setRenameTarget(undefined)}>
							取消
						</Button>
						<Button disabled={!renameValue || reviewing} onClick={() => void requestReview('rename', [renameTarget], renameValue)}>
							审阅重命名范围
						</Button>
					</div>
				</Modal>
			)}
			{showOperations && (
				<Modal title="操作记录" description="展示真实命令输出。取消不会回滚；结果待核实时请检查历史后再重试。" wide onClose={() => setShowOperations(false)}>
					<div className="operation-list">
						{!operations.length ? (
							<div className="empty">
								<Clock3 size={28} />
								尚无操作记录
							</div>
						) : (
							operations.map((operation) => (
								<details key={operation.id} className={`operation ${operation.state}`} open={['running', 'uncertain', 'failed'].includes(operation.state)}>
									<summary>
										<span className="operation-symbol">
											{['running', 'waiting'].includes(operation.state) ? (
												<LoaderCircle size={15} className="spin" />
											) : operation.state === 'success' ? (
												<CheckCircle2 size={15} />
											) : (
												<CircleAlert size={15} />
											)}
										</span>
										<strong>{operation.label}</strong>
										<span>{operation.wcId ? state.workingCopies.find((copy) => copy.id === operation.wcId)?.name : '远端仓库'}</span>
										<b>
											{operation.state === 'success' && operation.logs.some((line) => line.includes('个路径存在冲突'))
												? '完成 · 存在冲突'
												: opLabels[operation.state]}
										</b>
										{['waiting', 'running'].includes(operation.state) && (
											<button
												onClick={(event) => {
													event.preventDefault();
													void api.call('cancel', { id: operation.id }).catch(showError);
												}}
											>
												取消
											</button>
										)}
									</summary>
									<p>
										{fmtDate(operation.startedAt)}
										{operation.endedAt ? ` → ${fmtDate(operation.endedAt)}` : ''}
									</p>
									{operation.error && (
										<pre className="inline-error">
											{operation.error.message}
											{operation.error.detail ? `\n${operation.error.detail}` : ''}
										</pre>
									)}
									<pre className="operation-log">
										{operation.logs.join('') || (operation.state === 'waiting' ? '等待同一工作副本的前序写操作完成…' : '无额外命令输出')}
									</pre>
									{operation.state === 'uncertain' && operation.wcId && (
										<Button
											variant="outline"
											onClick={() => {
												activate(operation.wcId!);
												patchSession({ view: 'history', historyTarget: '.' }, operation.wcId);
												void refresh(operation.wcId);
												setShowOperations(false);
											}}
										>
											刷新并核实历史
										</Button>
									)}
								</details>
							))
						)}
					</div>
					<div className="dialog-footer">
						<Button variant="outline" onClick={() => setShowOperations(false)}>
							关闭记录
						</Button>
					</div>
				</Modal>
			)}
		</div>
	);
}
