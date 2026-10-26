import { useTranslation } from 'react-i18next';
import { isCancelledError, useQuery } from '@tanstack/react-query';
import { svnQueries } from '../queries/runtime';
import { workspaceStore } from '../state/workspace';
import type { WorkspaceCatalog } from '../state/workspace-store';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, KeyRound, LoaderCircle, Plus, RefreshCw, Server, Square, Star } from 'lucide-react';
import type { AppState, Review, RpcMap } from '../../../shared/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { RemoteRepositoryTree, remoteName, type RemoteTreeHandle } from './RemoteRepositoryTree';
import { DiffView } from './DiffView';
import { VirtualList } from './VirtualList';
import { api, errorText } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { toast } from 'sonner';
import { Combobox } from './ui/combobox';
import { Select } from './ui/select';
import { requestAuthentication } from '../lib/authentication';
export { api, errorText } from '../lib/api';

export function Modal({
	title,
	description,
	children,
	onClose,
	wide = false,
	className,
}: {
	title: string;
	description: string;
	children: React.ReactNode;
	onClose: () => void;
	wide?: boolean;
	className?: string;
}) {
	useTranslation();
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<DialogContent className={[wide ? 'wide' : '', className].filter(Boolean).join(' ')}>
				<DialogTitle className="dialog-title">{title}</DialogTitle>
				<DialogDescription className="dialog-description">{description}</DialogDescription>
				{children}
			</DialogContent>
		</Dialog>
	);
}

export { SettingsDialog } from './SettingsDialog';

function RemoteSurface({ children, title, description }: React.ComponentProps<typeof Modal>) {
	useTranslation();
	return (
		<section className="remote-surface">
			<div className="remote-surface-heading">
				<h2>{title}</h2>
				<p>{description}</p>
			</div>
			{children}
		</section>
	);
}

export function RemoteDialog({
	state,
	initialRepositoryId,
	initialUrl,
	embedded = false,
	onLocationChange,
	onRepositoryChange,
	onState,
	onClose,
}: {
	state: WorkspaceCatalog;
	initialRepositoryId?: string;
	initialUrl?: string;
	embedded?: boolean;
	onLocationChange?: (url: string) => void;
	onRepositoryChange?: (id?: string) => void;
	onState: (state: AppState) => void;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const initial = state.repositories.find((repo) => repo.id === initialRepositoryId);
	const [repositoryId, setRepositoryId] = useState(initial?.id ?? '');
	const [url, setUrl] = useState(initialUrl ?? initial?.rootUrl ?? '');
	const [loadedUrl, setLoadedUrl] = useState('');
	const [selectedKind, setSelectedKind] = useState('dir');
	const [treeUrl, setTreeUrl] = useState('');
	const [loadedTreeUrl, setLoadedTreeUrl] = useState('');
	const [treeVersion, setTreeVersion] = useState(0);
	const [pendingChildren, setPendingChildren] = useState(0);
	const remoteTree = useRef<RemoteTreeHandle>(null);
	const [listOptions, setListOptions] = useState<ReturnType<typeof svnQueries.listOptions>>();
	const listing = useQuery({ ...(listOptions ?? svnQueries.listOptions('')), enabled: false });
	const entries = listing.data ?? [];
	const listingRequest = useRef<ReturnType<typeof svnQueries.listOptions> | undefined>(undefined);
	const [name, setName] = useState('');
	const [parent, setParent] = useState('');
	const [folder, setFolder] = useState('');
	const [depth, setDepth] = useState<RpcMap['checkout']['input']['depth']>('infinity');
	const [busy, setBusy] = useState(false);
	const [stopped, setStopped] = useState(false);
	const [activeAction, setActiveAction] = useState<'browse' | 'bookmark' | 'checkout'>('browse');
	const [error, setError] = useState('');
	const request = useRef(0);
	const connection = useRef<AbortController | undefined>(undefined);
	useEffect(() => {
		if (initial) {
			void browse(initialUrl ?? initial.rootUrl, initial.id);
		}
		return () => {
			request.current++;
			connection.current?.abort();
		};
	}, []);

	function stopConnection(showMessage = true) {
		remoteTree.current?.cancel();
		request.current++;
		connection.current?.abort();
		if (listingRequest.current) {
			void svnQueries.client.cancelQueries({ queryKey: listingRequest.current.queryKey, exact: true });
		}
		connection.current = undefined;
		setBusy(false);
		setError('');
		setStopped(showMessage);
	}

	function close() {
		stopConnection(false);
		onClose();
	}

	async function authenticate() {
		stopConnection(false);
		const controller = new AbortController();
		connection.current = controller;
		try {
			const context = await api.call('authentication', { url, repositoryId: repositoryId || undefined });
			await requestAuthentication(context, controller.signal, 'edit');
		} catch (error) {
			notifyError(error);
		}
	}

	async function browse(target: string, id = repositoryId, useExistingAuthentication = false) {
		remoteTree.current?.cancel();
		connection.current?.abort();
		setTreeUrl(target);
		setLoadedTreeUrl('');
		setLoadedUrl('');
		setTreeVersion((previous) => previous + 1);
		setPendingChildren(0);
		setUrl(target);
		const controller = new AbortController();
		connection.current = controller;
		const version = ++request.current;
		setBusy(true);
		setStopped(false);
		setActiveAction('browse');
		setError('');
		try {
			const options = svnQueries.listOptions(target, id || undefined, workspaceStore.getState().connectionVersion, useExistingAuthentication);
			listingRequest.current = options;
			setListOptions(options);
			await svnQueries.client.cancelQueries({ queryKey: options.queryKey, exact: true });
			if (controller.signal.aborted) {
				throw {
					kind: 'cancelled',
					message: t('common.connectionStopped'),
				};
			}

			const abort = () => {
				void svnQueries.client.cancelQueries({ queryKey: options.queryKey, exact: true });
			};

			controller.signal.addEventListener('abort', abort, { once: true });
			try {
				await svnQueries.client.fetchQuery({ ...options, staleTime: 0 });
			} finally {
				controller.signal.removeEventListener('abort', abort);
			}
			if (version === request.current) {
				setLoadedTreeUrl(target);
				selectRemote(target, 'dir');
			}
		} catch (error) {
			if (version === request.current) {
				if ((error as { kind?: string }).kind === 'cancelled' || isCancelledError(error)) {
					setStopped(true);
				} else {
					setError(errorText(error));
					notifyError(error);
				}
			}
		} finally {
			if (version === request.current) {
				connection.current = undefined;
				setBusy(false);
			}
		}
	}

	function selectRemote(target: string, kind: string) {
		setLoadedUrl(target);
		setSelectedKind(kind);
		onLocationChange?.(target);
		if (kind === 'dir') {
			setFolder(remoteName(target) || 'working-copy');
		}
	}

	async function bookmark() {
		connection.current?.abort();
		const controller = new AbortController();
		connection.current = controller;
		const version = ++request.current;
		setBusy(true);
		setStopped(false);
		setActiveAction('bookmark');
		setError('');
		try {
			const next = await api.call('addRepository', { url, name }, { signal: controller.signal });
			if (version !== request.current) {
				return;
			}
			onState(next);
			toast.success(t('dialogs.repositoryBookmarkSaved'));
			const repo = next.repositories.find((repo) => url.startsWith(repo.rootUrl));
			if (repo) {
				setRepositoryId(repo.id);
				connection.current = undefined;
				await browse(url, repo.id);
			}
		} catch (error) {
			if (version === request.current) {
				if ((error as { kind?: string }).kind === 'cancelled' || isCancelledError(error)) {
					setStopped(true);
				} else {
					notifyError(error);
				}
			}
		} finally {
			if (version === request.current) {
				connection.current = undefined;
				setBusy(false);
			}
		}
	}

	async function checkout() {
		connection.current?.abort();
		const controller = new AbortController();
		connection.current = controller;
		const version = ++request.current;
		setBusy(true);
		setStopped(false);
		setActiveAction('checkout');
		setError('');
		try {
			if (!folder || /[/\\\r\n]/.test(folder) || folder === '.' || folder === '..') {
				throw new Error(t('dialogs.enterAValidDestinationFolderName'));
			}
			await api.call(
				'checkout',
				{ url: loadedUrl, destination: `${parent.replace(/\/$/, '')}/${folder}`, repositoryId: repositoryId || undefined, depth },
				{ signal: controller.signal },
			);
			if (version === request.current) {
				connection.current = undefined;
				onClose();
			}
		} catch (error) {
			if (version === request.current) {
				if ((error as { kind?: string }).kind === 'cancelled' || isCancelledError(error)) {
					setStopped(true);
				} else {
					notifyError(error);
				}
			}
		} finally {
			if (version === request.current) {
				connection.current = undefined;
				setBusy(false);
			}
		}
	}

	const Surface = embedded ? RemoteSurface : Modal;
	const repository = state.repositories.find((repo) => repo.id === repositoryId);
	const root = repository?.rootUrl;
	const connecting = busy || pendingChildren > 0;
	const validDirectory = !!loadedUrl && selectedKind === 'dir' && loadedTreeUrl === treeUrl && url === treeUrl;
	return (
		<Surface title={t('dialogs.browseRepositoryAndCheckOut')} description={t('dialogs.browseRemoteDirectoriesAndCheckOutAnIndependent')} wide onClose={close}>
			<div className="remote-top">
				<Server size={18} />
				<Combobox
					label={t('dialogs.repository')}
					value={repositoryId}
					options={[
						{
							value: '',
							label: t('dialogs.addANewRepositoryUrl'),
						},
						...state.repositories.map((repo) => ({ value: repo.id, label: repo.name, description: repo.rootUrl })),
					]}
					onValueChange={(id) => {
						if (embedded && onRepositoryChange) {
							onRepositoryChange(id || undefined);
							return;
						}
						stopConnection(false);
						setRepositoryId(id);
						const repo = state.repositories.find((repo) => repo.id === id);
						if (repo) {
							void browse(repo.rootUrl, id);
						} else {
							setUrl('');
							setListOptions(undefined);
							setLoadedUrl('');
							setTreeUrl('');
							setLoadedTreeUrl('');
						}
					}}
				/>
			</div>
			<div className="input-action">
				<input
					aria-label={t('detailsPanel.repositoryUrl')}
					value={url}
					onChange={(event) => {
						if (connection.current || pendingChildren) {
							stopConnection(false);
						}
						setUrl(event.target.value);
					}}
					placeholder="https://svn.example.com/repository"
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							void browse(url);
						}
					}}
				/>
				<Button
					variant="outline"
					disabled={!url}
					onClick={() => {
						if (connecting) {
							stopConnection();
						} else {
							void browse(url);
						}
					}}
				>
					{connecting ? <Square /> : <RefreshCw />}
					{connecting ? (activeAction === 'checkout' ? t('dialogs.cancelCheckout') : t('dialogs.stopConnecting')) : t('dialogs.browse')}
				</Button>
				<Button
					variant="ghost"
					size="icon"
					aria-label={t('dialogs.connectionCredentials')}
					title={t('dialogs.connectionCredentials')}
					disabled={!url}
					onClick={() => void authenticate()}
				>
					<KeyRound />
				</Button>
			</div>
			{!repositoryId && (
				<div className="bookmark-form">
					<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('dialogs.bookmarkNameOptional')} />
					<Button variant="outline" disabled={busy || !url} onClick={() => void bookmark()}>
						<Plus />
						{t('dialogs.verifyAndSaveBookmark')}
					</Button>
				</div>
			)}
			<div className="remote-path">
				<Button
					variant="ghost"
					size="icon"
					aria-label={t('dialogs.parentDirectory')}
					disabled={!loadedTreeUrl || treeUrl.replace(/\/$/, '') === root?.replace(/\/$/, '') || busy || url !== treeUrl}
					onClick={() => {
						const target = new URL(treeUrl);
						target.pathname = target.pathname.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/';
						void browse(target.href);
					}}
				>
					<ArrowLeft />
				</Button>
				<span className="truncate" title={loadedUrl}>
					{loadedUrl || t('dialogs.notConnectedToARepository')}
				</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={!validDirectory || !repositoryId || busy}
					title={t('dialogs.saveThisRemotePathUnderItsRepositoryIn')}
					onClick={() => {
						const name = remoteName(loadedUrl) || t('svn.repositoryRoot');
						void api
							.call('bookmark', { repositoryId, url: loadedUrl, name })
							.then((next) => {
								onState(next);
								toast.success(t('dialogs.remotePathSavedToTheSidebar'));
							})
							.catch(notifyError);
					}}
				>
					<Star />
					{t('dialogs.savePath')}
				</Button>
			</div>
			<RemoteRepositoryTree
				key={treeVersion}
				ref={remoteTree}
				rootUrl={treeUrl}
				rootName={remoteName(treeUrl) || repository?.name || t('svn.repositoryRoot')}
				entries={entries}
				rootState={busy && activeAction === 'browse' ? 'loading' : error ? 'error' : loadedTreeUrl ? 'loaded' : stopped ? 'cancelled' : 'idle'}
				rootError={error}
				repositoryId={repositoryId}
				selectedUrl={loadedUrl}
				onSelect={selectRemote}
				onPendingChange={setPendingChildren}
				onRetry={() => void browse(url)}
				onCancel={() => stopConnection()}
			/>

			<div className="checkout-fields">
				<label>
					{t('dialogs.checkOutToParentFolder')}
					<div className="input-action">
						<input value={parent} onChange={(event) => setParent(event.target.value)} placeholder={t('dialogs.chooseALocalFolder')} />
						<Button
							variant="outline"
							onClick={() => {
								void api.call('pickFolder', undefined).then((path) => {
									if (path) {
										setParent(path);
									}
								});
							}}
						>
							{t('dialogs.choose')}
						</Button>
					</div>
				</label>
				<div className="form-grid">
					<label>
						{t('dialogs.newFolderName')}
						<input value={folder} onChange={(event) => setFolder(event.target.value)} />
					</label>
					<label>
						{t('dialogs.checkoutDepth')}
						<Select
							label={t('dialogs.checkoutDepth')}
							value={depth}
							options={[
								{
									value: 'infinity',
									label: t('dialogs.fullDirectoryRecursive'),
								},
								{
									value: 'immediates',
									label: t('dialogs.immediateChildren'),
								},
								{
									value: 'files',
									label: t('dialogs.filesAtThisLevelOnly'),
								},
								{
									value: 'empty',
									label: t('dialogs.emptyDirectory'),
								},
							]}
							onValueChange={(value) => setDepth(value as typeof depth)}
						/>
					</label>
				</div>
				<p className="hint">{t('dialogs.theDestinationFolderMustNotExistInitialCheckout')}</p>
			</div>
			<div className="dialog-footer">
				<Button variant="outline" onClick={close}>
					{t('common.cancel')}
				</Button>
				<Button disabled={!validDirectory || !parent || !folder || busy} onClick={() => void checkout()}>
					{busy && activeAction === 'checkout' ? <LoaderCircle className="spin" /> : <Download />}
					{busy && activeAction === 'checkout' ? t('dialogs.preparingCheckout') : t('dialogs.checkOutThisDirectory')}
				</Button>
			</div>
		</Surface>
	);
}

export function ReviewDialog({ review, onClose, onExecute }: { review: Review; onClose: () => void; onExecute: () => Promise<void> }) {
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);
	const [checked, setChecked] = useState(false);
	const dangerous = ['revert', 'delete', 'resolve', 'recover', 'restore-backup', 'resolve-local', 'resolve-incoming', 'apply-merge'].includes(review.action);
	const labels: Record<Review['action'], string> = {
		commit: t('dialogs.confirmCommit'),
		update: t('operations.update'),
		add: t('operations.add'),
		rename: t('dialogs.confirmRename'),
		delete: t('dialogs.deleteDiskContent'),
		ignore: t('dialogs.setIgnoreRule'),
		revert: t('dialogs.revertSelectedLocalChanges'),
		resolve: t('dialogs.markAsResolved'),
		cleanup: t('operations.cleanup'),
		recover: t('operations.recover'),
		'restore-backup': t('operations.restore-backup'),
		'resolve-local': t('operations.resolve-local'),
		'resolve-incoming': t('operations.resolve-incoming'),
		merge: t('operations.merge'),
		'apply-merge': t('operations.apply-merge'),
	};
	return (
		<Modal
			title={review.action === 'commit' ? t('dialogs.commitReview') : t('dialogs.confirmOperationScope')}
			description={t('dialogs.filesAndPropertiesWillBeCheckedAgainBefore')}
			className={review.sourceFingerprint ? 'content-review-dialog' : undefined}
			wide
			onClose={onClose}
		>
			<div className="review-summary">
				<span>{labels[review.action]}</span>
				<strong>
					{t('dialogs.explicitTargets', {
						count: review.paths.length,
					})}
				</strong>
			</div>
			{review.message && <pre className="review-message">{review.message}</pre>}
			{review.warning && <div className="warning-box">{review.warning}</div>}
			{review.reasons.length > 0 && (
				<div className="scope-notice">
					{review.reasons.map((reason) => (
						<div key={reason}>{reason}</div>
					))}
				</div>
			)}
			<div className="review-paths">
				<VirtualList
					items={review.paths.length ? review.paths : [t('dialogs.entireWorkingCopyExcludingExternals')]}
					label={t('dialogs.actualOperationScope')}
					height={30}
					render={(path) => (
						<div className="review-path">
							<span className="path-status">{review.requested.includes(path) ? t('dialogs.selected') : t('dialogs.related')}</span>
							<code>{path}</code>
						</div>
					)}
				/>
			</div>
			{review.preview && (
				<div className="review-content-preview">
					<p>{t('fileVersions.reviewCaption')}</p>
					<DiffView
						labels={{ left: t('fileVersions.current'), right: t('fileVersions.selected') }}
						emptyMessage={t('fileVersions.noChanges')}
						text={review.preview.text}
						unsupported={review.preview.unsupported}
						loading={false}
						title={review.paths[0]}
					/>
				</div>
			)}
			{review.action === 'commit' && <p className="hint">{t('dialogs.onlyThePathsListedAboveWillBeCommitted')}</p>}
			{dangerous && (
				<label className="confirm-check">
					<input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
					{t('dialogs.iReviewedTheActualScopeAndUnderstandThese')}
				</label>
			)}
			<div className="dialog-footer">
				<Button variant="outline" disabled={busy} onClick={onClose}>
					{t('dialogs.backToReview')}
				</Button>
				<Button
					variant={dangerous ? 'destructive' : 'default'}
					disabled={busy || (dangerous && !checked)}
					onClick={async () => {
						setBusy(true);
						try {
							await onExecute();
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy && <LoaderCircle className="spin" />}
					{labels[review.action]}
				</Button>
			</div>
		</Modal>
	);
}
