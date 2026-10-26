import { FileVersionsDialog } from './components/FileVersionsDialog';
import { operationAction } from '../../shared/operation-log';
import { useTranslation } from 'react-i18next';
import { getTheme } from '../../shared/themes';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
	Archive,
	ArrowDownToLine,
	Check,
	CheckCircle2,
	ChevronDown,
	Clock3,
	Cloud,
	Code2,
	Copy,
	EyeOff,
	FileDiff,
	Files,
	Folder,
	FolderGit2,
	History,
	Keyboard,
	LoaderCircle,
	PanelRightClose,
	PanelRightOpen,
	Pencil,
	Plus,
	RefreshCw,
	RotateCcw,
	Settings2,
	ShieldCheck,
	Terminal,
	Trash2,
	Upload,
} from 'lucide-react';
import { isChanged, isConflict, type Action, type AppState, type Operation, type Review, type WorkspaceSession } from '../../shared/types';
import { Button } from './components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './components/ui/dropdown-menu';
import { api, errorText, Modal, RemoteDialog, ReviewDialog, SettingsDialog } from './components/Dialogs';
import { CommitPanel } from './components/CommitPanel';
import { WorkspaceNavigation } from './components/WorkspaceNavigation';
import { Combobox } from './components/ui/combobox';
import { notifyError } from './lib/feedback';
import { requestAuthentication } from './lib/authentication';
import { toast } from 'sonner';
import { useQueries, isCancelledError } from '@tanstack/react-query';
import { acceptOperation, svnQueries, subscribeWorkspaceRuntime } from './queries/runtime';
import { queryKeys } from './queries/svn-queries';
import { useStatus, useOperationSummary } from './queries/hooks';
import { useForegroundRefresh } from './queries/use-foreground-refresh';
import { workspaceStore, useWorkspaceStore } from './state/workspace';
import { WorkingCopyView } from './components/WorkingCopyView';
import { WorkspaceViewTabs, WorkingCopyMenu, WorkspaceStatus } from './components/WorkspaceToolbar';
import { OperationsDialog } from './components/OperationsDialog';
import { resizePanel as resize } from './lib/panel-resize';

const setShowDetails = (value: boolean | ((previous: boolean) => boolean)) => workspaceStore.getState().setPanel('showDetails', value);

const setShowOperations = (value: boolean | ((previous: boolean) => boolean)) => workspaceStore.getState().setPanel('showOperations', value);

const setSidebarWidth = (value: number | ((previous: number) => number)) => workspaceStore.getState().setSize('sidebarWidth', value);

export function App() {
	const { t } = useTranslation();
	const state = useWorkspaceStore((store) => store.catalog);
	const activeId = useWorkspaceStore((store) => store.activeId);
	const operations = useOperationSummary();
	const [modal, setModal] = useState<'settings' | 'remote' | 'commit' | 'group' | 'manage' | null>(null);
	const [updateRequest, setUpdateRequest] = useState(0);
	const [remoteId, setRemoteId] = useState<string>();
	const [review, setReview] = useState<Review>();
	const [fileVersions, setFileVersions] = useState<{ wcId: string; path: string; revision?: number }>();
	const [reviewing, setReviewing] = useState(false);
	const [bootError, setBootError] = useState('');
	const [activeRepositoryId, setActiveRepositoryId] = useState<string>();
	const [remoteUrl, setRemoteUrl] = useState<string>();
	const [remoteLocation, setRemoteLocation] = useState<string>();
	const [previewHidden, setPreviewHidden] = useState(false);
	const showDetails = useWorkspaceStore((store) => store.showDetails);
	const showOperations = useWorkspaceStore((store) => store.showOperations);
	const sidebarWidth = useWorkspaceStore((store) => store.sidebarWidth);
	const [context, setContext] = useState<{ x: number; y: number; path: string }>();
	const [manage, setManage] = useState<{ entity: 'workingCopy' | 'repository' | 'group'; id: string }>();
	const [editName, setEditName] = useState('');
	const [renameTarget, setRenameTarget] = useState<string>();
	const [renameValue, setRenameValue] = useState('');
	const [detection, setDetection] = useState<{ ok: boolean; version: string }>();
	const detected = detection ? (detection.ok ? `SVN ${detection.version}` : t('workspace.svnNotConfigured')) : t('workspace.detecting');
	const navigateRef = useRef<(action: string) => void>(() => {});
	const wc = activeRepositoryId ? undefined : state?.workingCopies.find((copy) => copy.id === activeId);
	const wcRepository = state?.repositories.find((repository) => repository.id === wc?.repositoryId);
	const activeRepository = state?.repositories.find((repo) => repo.id === activeRepositoryId);
	const snapshot = useStatus(activeId).data;
	useForegroundRefresh(wc?.id);
	const revertiblePaths = useMemo(() => {
		const paths = new Set<string>();
		for (const file of snapshot?.files ?? []) {
			if (!isChanged(file) || file.external) {
				continue;
			}
			paths.add(file.path);
			paths.add('.');
			let ancestor = file.path;
			while (ancestor.includes('/')) {
				ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
				paths.add(ancestor);
			}
		}
		return paths;
	}, [snapshot]);
	const statusQueries = useQueries({ queries: (state?.workingCopies ?? []).map((copy) => svnQueries.statusOptions(copy.id)) });
	const loading = Object.fromEntries((state?.workingCopies ?? []).map((copy, index) => [copy.id, statusQueries[index].isFetching]));
	const preparingUpdate = useWorkspaceStore((store) => !!(activeId && store.updateIntents[activeId]?.preparing));
	const updating = operations.some((operation) => operation.wcId === activeId && operationAction(operation) === 'update' && ['waiting', 'running'].includes(operation.state));
	const busyWrite = preparingUpdate || operations.some((operation) => operation.wcId === activeId && ['waiting', 'running'].includes(operation.state));
	const changed = snapshot?.files.filter(isChanged) ?? [];
	const commitFiles = changed.filter((file) => !isConflict(file) && !file.external && !['missing', 'obstructed', 'incomplete'].includes(file.item));
	const acceptState = useCallback((next: AppState) => workspaceStore.getState().accept(next), []);
	const patchSession = workspaceStore.getState().patchSession;
	const showError = useCallback((error: unknown) => {
		if (!workspaceStore.getState().catalog) {
			setBootError(errorText(error));
		}
		if (!isCancelledError(error)) {
			notifyError(error);
		}
	}, []);
	const refresh = useCallback(
		async (id?: string, remote = false, announce = false) => {
			if (!id) {
				return;
			}
			try {
				const next = await svnQueries.refreshStatus(id, remote);
				if (remote) {
					toast.info(
						t('workspace.remoteCheckCompleteChangedPaths', {
							value: next.remoteChanges ?? 0,
						}),
						{
							description: t('workspace.remoteStatusWasCheckedFilesOnDiskHave'),
						},
					);
				} else if (announce) {
					toast.success(t('workspace.localStatusRefreshed'));
				}
			} catch (error) {
				if (!isCancelledError(error) && (error as { kind?: string }).kind !== 'cancelled') {
					workspaceStore.getState().acceptScanError(id, errorText(error));
					if (announce || remote) {
						showError(error);
					}
				}
			}
		},
		[showError, t],
	);
	useEffect(() => {
		const unsubscribeRuntime = subscribeWorkspaceRuntime(showError);
		void api
			.call('detect', {})
			.then(setDetection)
			.catch(() => setDetection({ ok: false, version: '' }));
		const unsubscribeMenu = api.onNavigate((action) => navigateRef.current(action));
		return () => {
			unsubscribeRuntime();
			unsubscribeMenu();
		};
	}, []);
	useEffect(() => {
		if (!state) {
			return;
		}
		const theme = getTheme(state.settings.theme);
		document.documentElement.dataset.theme = theme.id;
		document.documentElement.classList.toggle('dark', theme.scheme === 'dark');
	}, [state?.settings.theme]);

	async function authenticate(url: string, repositoryId?: string) {
		try {
			await requestAuthentication(await api.call('authentication', { url, repositoryId }), undefined, 'edit');
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
			workspaceStore.getState().accept(next, true);
			setActiveRepositoryId(undefined);
			toast.success(t('workspace.workingCopyAdded'));
			if (next.activeId) {
				void refresh(next.activeId);
			}
		} catch (error) {
			showError(error);
		}
	}

	function activate(id: string) {
		setContext(undefined);
		setActiveRepositoryId(undefined);
		setRemoteUrl(undefined);
		setRemoteLocation(undefined);
		workspaceStore.getState().activate(id);
	}

	async function requestReview(action: Action, paths = activeId ? (workspaceStore.getState().sessions[activeId]?.selected ?? []) : [], destination?: string) {
		if (!activeId) {
			return;
		}
		setReviewing(true);
		try {
			await workspaceStore.getState().flushSessions(activeId);
			const next = await api.call('review', {
				wcId: activeId,
				action,
				paths,
				destination,
				message: action === 'commit' ? workspaceStore.getState().sessions[activeId]?.draft : undefined,
			});
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
			setRemoteLocation(url ?? workspaceStore.getState().catalog?.repositories.find((repo) => repo.id === id)?.rootUrl);
			setModal(null);
		} else {
			setRemoteId(undefined);
			setModal('remote');
		}
	}

	async function updateCopy() {
		if (!wc || reviewing) {
			return;
		}
		const wcId = wc.id;
		const queued = svnQueries.client.getQueryData<Operation[]>(queryKeys.operations) ?? [];
		if (queued.some((operation) => operation.wcId === wcId && ['waiting', 'running'].includes(operation.state))) {
			return;
		}
		const toastId = `update-${crypto.randomUUID()}`;
		// Guard before awaiting: another click or shortcut can precede the next render.
		if (!workspaceStore.getState().beginUpdate(wcId, toastId)) {
			return;
		}
		toast.loading(t('workspace.preparingToUpdateWorkingCopy'), {
			id: toastId,
			description: t('workspace.checkingTheWorkingCopyAndRepositoryConnection', {
				name: wc.name,
			}),
		});
		try {
			const next = await api.call('review', { wcId, action: 'update', paths: [] });
			const operation = await api.call('execute', { reviewId: next.id });
			acceptOperation(operation);
		} catch (error) {
			notifyError(error, toastId);
		} finally {
			workspaceStore.getState().finishUpdatePreparation(wcId, toastId);
		}
	}

	async function compareFile(path: string, revision?: number) {
		if (!activeId) {
			return;
		}
		try {
			await api.call('compare', { wcId: activeId, path, revision });
			toast.success(t('workspace.comparisonOpenedInFilemerge'));
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

	navigateRef.current = (action) => {
		if (action === 'settings') {
			setModal('settings');
		} else if (action === 'app-update') {
			setUpdateRequest((request) => request + 1);
			setModal('settings');
			void api.call('appUpdate', { action: 'check' }).catch(showError);
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
					{t('workspace.viewBuiltInDiff')}
				</DropdownMenuItem>,
				file?.kind === 'file' && (
					<DropdownMenuItem key="compare" icon={<Files />} onSelect={() => void compareFile(path)}>
						{t('workspace.compareInFilemerge')}
					</DropdownMenuItem>
				),
				file?.kind === 'file' && (
					<DropdownMenuItem
						key="versions"
						icon={<History />}
						onSelect={() => setFileVersions({ wcId: activeId!, path, revision: Number(file.revision) > 0 ? Number(file.revision) : undefined })}
					>
						{t('fileVersions.showVersions')}
					</DropdownMenuItem>
				),
				<DropdownMenuItem
					key="history"
					icon={<History />}
					onSelect={() => {
						patchSession({ view: 'history', historyTarget: path, historyDiffPath: path, historyRevision: undefined });
					}}
				>
					{t('workspace.showPathHistory')}
				</DropdownMenuItem>,
			],
			[
				file && isChanged(file) && !isConflict(file) && (
					<DropdownMenuItem key="commit" icon={<Upload />} onSelect={() => openCommit([path])}>
						{t('workspace.commitThisPath')}
					</DropdownMenuItem>
				),
				file?.item === 'unversioned' && (
					<DropdownMenuItem key="add" icon={<Plus />} onSelect={() => void requestReview('add', [path])}>
						{t('workspace.addToVersionControl')}
					</DropdownMenuItem>
				),
				file?.item === 'unversioned' && (
					<DropdownMenuItem key="ignore" icon={<EyeOff />} onSelect={() => void requestReview('ignore', [path])}>
						{t('workspace.ignoreThisName')}
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
						{t('workspace.renameMove')}
					</DropdownMenuItem>
				),
			],
			[
				file?.item === 'conflicted' && file.props !== 'conflicted' && !file.treeConflicted && (
					<DropdownMenuItem
						key="merge"
						icon={<Code2 />}
						onSelect={() => {
							void requestReview('merge', [path]);
						}}
					>
						{t('workspace.openInExternalMergeTool')}
					</DropdownMenuItem>
				),
				file && isConflict(file) && (
					<DropdownMenuItem key="check" icon={<RefreshCw />} onSelect={() => void refresh(activeId)}>
						{t('workspace.checkResolution')}
					</DropdownMenuItem>
				),
				file && isConflict(file) && (
					<DropdownMenuItem key="resolve" icon={<CheckCircle2 />} onSelect={() => void requestReview('resolve', [path])}>
						{t('workspace.acceptWorkingFileAndMarkResolved')}
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
					{t('workspace.revealInFinder')}
				</DropdownMenuItem>,
				<DropdownMenuItem
					key="copy"
					icon={<Copy />}
					onSelect={() => {
						void api.call('system', { wcId: activeId!, path, action: 'copy' }).catch(showError);
					}}
				>
					{t('workspace.copyAbsolutePath')}
				</DropdownMenuItem>,
				<DropdownMenuItem
					key="terminal"
					icon={<Terminal />}
					onSelect={() => {
						void api.call('system', { wcId: activeId!, path, action: 'terminal' }).catch(showError);
					}}
				>
					{t('workspace.openInTerminal')}
				</DropdownMenuItem>,
			],
			[
				revertiblePaths.has(path) && (
					<DropdownMenuItem key="revert" icon={<RotateCcw />} destructive onSelect={() => void requestReview('revert', [path])}>
						{path === '.' ? t('workspace.revertAllLocalChanges') : t('workspace.revertLocalChanges')}
					</DropdownMenuItem>
				),
				canEdit && (
					<DropdownMenuItem key="delete" icon={<Trash2 />} destructive onSelect={() => void requestReview('delete', [path])}>
						{t('workspace.deleteDiskContentAndScheduleSvnDeletion')}
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
				<h1>{t('common.appName')}</h1>
				<p>{t('workspace.loadingLocalWorkspace')}</p>
				{bootError && <pre className="inline-error">{bootError}</pre>}
			</div>
		);
	}
	const activeOps = operations.filter((operation) => ['running', 'waiting'].includes(operation.state));
	return (
		<div className="app-shell" style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
			<header className="titlebar">
				<div className="titlebar-sidebar">
					<div className="traffic-space" />
				</div>
				{wc ? (
					<div className="project-header">
						<div className="project-heading">
							<div>
								<h1>{wc.name}</h1>
								<div className="project-path" title={`${wc.path}\n${wc.url}`}>
									{wcRepository?.name} / {decodeURIComponent(wc.url.slice(wcRepository?.rootUrl.length ?? 0)).replace(/^\//, '') || '/'}
								</div>
							</div>
						</div>
						<WorkspaceViewTabs wcId={wc.id} />
						<div className="project-actions">
							<Button
								variant="ghost"
								size="icon"
								aria-label={t('common.refreshLocalStatus')}
								title={t('workspace.refreshLocalStatusR')}
								disabled={!!loading[wc.id]}
								onClick={() => void refresh(wc.id, false, true)}
							>
								<RefreshCw className={loading[wc.id] ? 'spin' : ''} />
							</Button>
							<Button variant="outline" disabled={busyWrite || reviewing} aria-busy={preparingUpdate || updating || undefined} onClick={() => void updateCopy()}>
								{preparingUpdate || updating ? <LoaderCircle className="spin" /> : <ArrowDownToLine />}
								{t('workspace.update')}
							</Button>
							<Button disabled={busyWrite || reviewing || !snapshot || !commitFiles.length} onClick={() => openCommit()}>
								<Upload />
								{t('desktop.commit')}
								<span className="button-count">{commitFiles.length}</span>
							</Button>
							<WorkingCopyMenu wc={wc} refresh={refresh} requestReview={requestReview} />
						</div>
					</div>
				) : (
					<div className="window-title">
						<strong>{activeRepository?.name ?? t('workspace.workspace')}</strong>
						<span>{activeRepository?.rootUrl ?? 'svnbox'}</span>
					</div>
				)}
				<Button
					variant="ghost"
					size="icon"
					aria-label={t('workspace.toggleInspector')}
					title={t('workspace.toggleInspector')}
					onClick={() => setShowDetails((value) => !value)}
				>
					{showDetails ? <PanelRightClose /> : <PanelRightOpen />}
				</Button>
			</header>
			<div
				className="sidebar-resizer"
				role="separator"
				aria-label={t('workspace.resizeNavigation')}
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
							<span>{t('desktop.operations')}</span>
							{activeOps.length > 0 ? <span className="nav-count">{activeOps.length}</span> : <kbd>⌘J</kbd>}
						</button>
						<button onClick={() => setModal('settings')}>
							<Settings2 size={15} />
							<span>{t('common.settings')}</span>
							<kbd>⌘,</kbd>
						</button>
					</div>
				</aside>
				<div className="sidebar-divider" aria-hidden="true" />
				<main className="main-area">
					{wc ? (
						<WorkingCopyView
							key={wc.id}
							wc={wc}
							previewHidden={previewHidden}
							setPreviewHidden={setPreviewHidden}
							fileActions={fileActions}
							setContext={setContext}
							compareFile={(path, revision) => void compareFile(path, revision)}
							refresh={refresh}
							requestReview={requestReview}
							openCommit={() => openCommit()}
						/>
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
							<div className="eyebrow">{t('workspace.svnbox')}</div>
							<h1>{t('workspace.aPlaceForEveryProject')}</h1>
							<p>
								{t('workspace.bringRepositoriesAndWorkingCopiesIntoSvnbox')}
								<br />
								{t('workspace.reviewChangesClearlyCommitEachRevisionWithConfidence')}
							</p>
							<div className="welcome-buttons">
								<Button onClick={() => void addWorkingCopy()}>
									<Plus />
									{t('workspace.addExistingWorkingCopy')}
								</Button>
								<Button variant="outline" onClick={() => openRemote()}>
									<Cloud />
									{t('workspace.browseAndCheckOut')}
								</Button>
							</div>
							<div className="welcome-features">
								<span>
									<FolderGit2 />
									{t('workspace.independentWorkingCopies')}
								</span>
								<span>
									<FileDiff />
									{t('workspace.textAndPropertyDiffs')}
								</span>
								<span>
									<ShieldCheck />
									{t('workspace.reviewTheCommitScope')}
								</span>
							</div>
							<div className="welcome-shortcut">
								<Keyboard size={14} />
								{t('workspace.oAddWorkingCopy')}
								<span>·</span>
								{t('workspace.switchViews')}
								<span>·</span>
								{t('workspace.commit')}
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
					{wc
						? t('workspace.workingCopies', {
								value: wc.depth === 'infinity' ? t('workspace.fullDepth') : wc.depth,
								count: state.workingCopies.length,
							})
						: t('workspace.ready')}
				</div>
				{wc && <WorkspaceStatus wc={wc} />}
				<button onClick={() => setShowOperations((value) => !value)}>
					{activeOps.length > 0 ? (
						<>
							<LoaderCircle size={11} className="spin" />
							{t('workspace.operationsRunning', { count: activeOps.length })}
						</>
					) : (
						<>
							<Check size={12} />
							{t('workspace.ready2')}
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
			{modal === 'settings' && (
				<SettingsDialog
					state={state}
					onState={acceptState}
					updateRequest={updateRequest}
					onClose={() => {
						setModal(null);
						setUpdateRequest(0);
					}}
				/>
			)}
			{modal === 'remote' && <RemoteDialog state={state} initialRepositoryId={remoteId} onState={acceptState} onClose={() => setModal(null)} />}
			{modal === 'commit' && wc && (
				<CommitPanel
					key={wc.id}
					copy={wc}
					files={commitFiles}
					recentMessages={state.recentMessages}
					blocked={changed.length - commitFiles.length}
					busy={reviewing || busyWrite}
					onReview={(paths) => void requestReview('commit', paths)}
					onClose={() => setModal(null)}
				/>
			)}

			{fileVersions && <FileVersionsDialog key={`${fileVersions.wcId}:${fileVersions.path}`} {...fileVersions} onClose={() => setFileVersions(undefined)} />}
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
				<Modal
					title={modal === 'group' ? t('workspace.newGroup') : t('workspace.manageRecord')}
					description={t('workspace.recordsOnlyAffectTheSvnboxListRemovingA')}
					onClose={() => setModal(null)}
				>
					<label>
						{t('workspace.name')}
						<input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} />
					</label>
					{modal === 'manage' && manage?.entity !== 'group' && (
						<label>
							{t('workspace.group')}
							<Combobox
								label={t('workspace.group')}
								value={(manage?.entity === 'workingCopy' ? state.workingCopies : state.repositories).find((item) => item.id === manage?.id)?.groupId ?? ''}
								options={[
									{
										value: '',
										label: t('workspace.ungrouped'),
									},
									...state.groups.map((group) => ({ value: group.id, label: group.name })),
								]}
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
							{t('workspace.connectionCredentials')}
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
											toast.success(t('workspace.managementRecordUpdated'));
											setModal(null);
										})
										.catch(showError);
								}}
							>
								<Trash2 />
								{t('workspace.removeManagementRecord')}
							</Button>
						)}
						<Button variant="outline" onClick={() => setModal(null)}>
							{t('common.cancel')}
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
							{t('common.save')}
						</Button>
					</div>
				</Modal>
			)}
			{renameTarget && (
				<Modal title={t('workspace.renameMove2')} description={t('workspace.enterARelativeDestinationWithinThisWorkingCopy')} onClose={() => setRenameTarget(undefined)}>
					<p className="hint">
						{t('workspace.source', {
							renameTarget: renameTarget,
						})}
					</p>
					<label>
						{t('workspace.relativeDestinationPath')}
						<input autoFocus value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
					</label>
					<div className="dialog-footer">
						<Button variant="outline" onClick={() => setRenameTarget(undefined)}>
							{t('common.cancel')}
						</Button>
						<Button disabled={!renameValue || reviewing} onClick={() => void requestReview('rename', [renameTarget], renameValue)}>
							{t('workspace.reviewRenameScope')}
						</Button>
					</div>
				</Modal>
			)}
			{showOperations && (
				<OperationsDialog
					onVerify={(id) => {
						activate(id);
						patchSession({ view: 'history', historyTarget: '.' }, id);
						void svnQueries.verifyHistory(id);
						void refresh(id);
					}}
				/>
			)}
		</div>
	);
}
