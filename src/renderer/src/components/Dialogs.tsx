import { useTranslation } from 'react-i18next';
import { isCancelledError, useQuery } from '@tanstack/react-query';
import { svnQueries } from '../queries/runtime';
import { workspaceStore } from '../state/workspace';
import type { WorkspaceCatalog } from '../state/workspace-store';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Download, Folder, KeyRound, LoaderCircle, Plus, RefreshCw, Server, Square, Star } from 'lucide-react';
import type { AppState, Review, RpcMap } from '../../../shared/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { VirtualList } from './VirtualList';
import { FileIcon } from './FileIcon';
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
		connection.current?.abort();
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
				setLoadedUrl(target);
				onLocationChange?.(target);
				setUrl(target);
				setFolder(decodeURIComponent(target.split('/').filter(Boolean).at(-1) || 'working-copy'));
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
	const root = state.repositories.find((repo) => repo.id === repositoryId)?.rootUrl;
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
						setRepositoryId(id);
						const repo = state.repositories.find((repo) => repo.id === id);
						if (repo) {
							void browse(repo.rootUrl, id);
						} else {
							setUrl('');
							setListOptions(undefined);
							setLoadedUrl('');
						}
					}}
				/>
			</div>
			<div className="input-action">
				<input
					aria-label={t('detailsPanel.repositoryUrl')}
					value={url}
					onChange={(event) => {
						if (connection.current) {
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
						if (busy) {
							stopConnection();
						} else {
							void browse(url);
						}
					}}
				>
					{busy ? <Square /> : <RefreshCw />}
					{busy ? (activeAction === 'checkout' ? t('dialogs.cancelCheckout') : t('dialogs.stopConnecting')) : t('dialogs.browse')}
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
					disabled={!loadedUrl || loadedUrl === root || busy}
					onClick={() => {
						const target = new URL(loadedUrl);
						target.pathname = target.pathname.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/';
						void browse(target.href);
					}}
				>
					<ArrowLeft />
				</Button>
				<span className="truncate">{loadedUrl || t('dialogs.notConnectedToARepository')}</span>
				<span className="muted">
					{t('dialogs.items', {
						count: entries.length,
					})}
				</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={!loadedUrl || !repositoryId || busy}
					title={t('dialogs.saveThisRemotePathUnderItsRepositoryIn')}
					onClick={() => {
						const name = decodeURIComponent(loadedUrl.replace(/\/$/, '').split('/').at(-1) || t('svn.repositoryRoot'));
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
			<div className="remote-list">
				{busy ? (
					<div className="empty">
						<LoaderCircle className="spin" />
						{activeAction === 'checkout' ? t('dialogs.preparingCheckout') : t('dialogs.connectingToRepository')}
						<span className="hint">{t('dialogs.useTheButtonAboveToStopOrEnter')}</span>
					</div>
				) : stopped ? (
					<div className="empty">
						<Square size={24} />
						<strong>{t('common.connectionStopped')}</strong>
						<span>{t('dialogs.changeTheUrlOrCredentialsAndReconnect')}</span>
						<Button variant="outline" size="sm" onClick={() => void browse(url)}>
							{t('dialogs.reconnect')}
						</Button>
					</div>
				) : error ? (
					<div className="empty error-text">
						<Server size={24} />
						<strong>{t('dialogs.unableToConnectToRepository')}</strong>
						<span>{error.split('\n')[0]}</span>
						<Button variant="outline" size="sm" onClick={() => void browse(url)}>
							{t('dialogs.reconnect')}
						</Button>
					</div>
				) : !entries.length ? (
					<div className="empty">
						<Folder size={28} />
						{t('dialogs.thisDirectoryIsEmptyOrHasNotBeen')}
					</div>
				) : (
					<VirtualList
						items={entries}
						label={t('dialogs.remoteDirectory')}
						render={(entry) => (
							<button
								className="remote-entry"
								disabled={entry.kind !== 'dir'}
								onClick={() => void browse(`${loadedUrl.replace(/\/$/, '')}/${encodeURIComponent(entry.name)}`)}
							>
								<FileIcon path={entry.name} kind={entry.kind} />
								<span>
									{entry.name}
									{entry.kind === 'dir' ? '/' : ''}
								</span>
								<small>r{entry.revision}</small>
								<small>{entry.author}</small>
								{entry.kind === 'dir' && <ChevronRight size={13} />}
							</button>
						)}
					/>
				)}
			</div>
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
				<Button disabled={!loadedUrl || !parent || !folder || busy || url !== loadedUrl} onClick={() => void checkout()}>
					<Download />
					{t('dialogs.checkOutThisDirectory')}
				</Button>
			</div>
		</Surface>
	);
}

export function ReviewDialog({ review, onClose, onExecute }: { review: Review; onClose: () => void; onExecute: () => Promise<void> }) {
	const { t } = useTranslation();
	const [busy, setBusy] = useState(false);
	const [checked, setChecked] = useState(false);
	const dangerous = ['revert', 'delete', 'resolve'].includes(review.action);
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
	};
	return (
		<Modal
			title={review.action === 'commit' ? t('dialogs.commitReview') : t('dialogs.confirmOperationScope')}
			description={t('dialogs.filesAndPropertiesWillBeCheckedAgainBefore')}
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
