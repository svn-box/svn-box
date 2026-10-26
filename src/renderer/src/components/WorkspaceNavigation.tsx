import { formatDateTime } from '../../../shared/i18n/format';
import { useTranslation } from 'react-i18next';
import type { WorkspaceCatalog } from '../state/workspace-store';
import { useRef, useState } from 'react';
import {
	ArrowDown,
	ArrowUp,
	ChevronRight,
	CircleAlert,
	Cloud,
	KeyRound,
	Folder,
	FolderGit2,
	LoaderCircle,
	Pencil,
	Plus,
	RefreshCw,
	Search,
	Settings2,
	Star,
	Terminal,
	Trash2,
} from 'lucide-react';
import type { AppState, Operation, RemoteBookmark, WorkingCopy } from '../../../shared/types';
import { findCredential } from '../../../shared/auth';
import { api } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/context-menu';

export function WorkspaceNavigation({
	state,
	activeId,
	activeRepositoryId,
	activeUrl,
	operations,
	onState,
	onActivate,
	onRemote,
	onAuthenticate,
	onAddCopy,
	onGroup,
	onManage,
	onRefresh,
}: {
	state: WorkspaceCatalog;
	activeId?: string;
	activeRepositoryId?: string;
	activeUrl?: string;
	operations: Pick<Operation, 'id' | 'wcId' | 'state'>[];
	onState: (state: AppState) => void;
	onActivate: (id: string) => void;
	onRemote: (id?: string, url?: string) => void;
	onAuthenticate: (url: string, repositoryId: string) => void;
	onAddCopy: () => void;
	onGroup: () => void;
	onManage: (entity: 'workingCopy' | 'repository' | 'group', id: string, name: string) => void;
	onRefresh: (id: string) => void;
}) {
	const { t } = useTranslation();
	const [search, setSearch] = useState('');
	const [collapsed, setCollapsed] = useState<string[]>([]);
	const [editing, setEditing] = useState<{ bookmark: RemoteBookmark; name: string }>();
	const renameAfterClose = useRef<RemoteBookmark | undefined>(undefined);
	const query = search.trim().toLocaleLowerCase();

	const matches = (text: string) => !query || text.toLocaleLowerCase().includes(query);

	async function forgetAuthentication(url: string, preferredId?: string) {
		const profile = findCredential(state.credentials, url, preferredId);
		if (!profile?.rootUrl) {
			return;
		}
		try {
			onState(await api.call('credential', { id: profile.id, rootUrl: profile.rootUrl, username: '', password: '', remove: true }));
			toast.success(t('workspaceNavigation.connectionCredentialsForgotten'));
		} catch (error) {
			notifyError(error);
		}
	}

	function copyRow(copy: WorkingCopy, shortcut = false) {
		const running = operations.some((operation) => operation.wcId === copy.id && ['waiting', 'running'].includes(operation.state));
		const repo = state.repositories.find((repo) => repo.id === copy.repositoryId);
		const location = decodeURIComponent(copy.url.slice(repo?.rootUrl.length ?? 0)) || '/';
		return (
			<ContextMenu key={copy.id}>
				<ContextMenuTrigger asChild>
					<div className={`nav-copy ${shortcut ? 'shortcut' : ''} ${!activeRepositoryId && copy.id === activeId ? 'active' : ''}`}>
						<button
							className="nav-copy-main"
							aria-label={t('workspaceNavigation.localWorkingCopy', {
								name: copy.name,
								value: copy.url.split('/').at(-1) || '/',
							})}
							title={t('workspaceNavigation.lastScanned', {
								path: copy.path,
								url: copy.url,
								value: copy.lastScan ? formatDateTime(copy.lastScan) : t('workspaceNavigation.notScannedYet'),
							})}
							onClick={() => onActivate(copy.id)}
						>
							<span className={`project-icon ${copy.error ? 'invalid' : ''}`}>{copy.error ? <CircleAlert size={15} /> : <FolderGit2 size={15} />}</span>
							<span className="nav-copy-text">
								<strong>{copy.name}</strong>
								<small>{copy.error ? t('workspaceNavigation.pathOrConnectionError') : location}</small>
							</span>
							{running ? (
								<LoaderCircle size={12} className="spin" />
							) : copy.conflicts ? (
								<span
									className="conflict-count"
									title={t('workspaceNavigation.conflicts', {
										conflicts: copy.conflicts,
									})}
								>
									! {copy.conflicts}
								</span>
							) : (
								<span className="nav-count">{copy.changeCount ?? '—'}</span>
							)}
						</button>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent
					aria-label={t('workspaceNavigation.workingCopy', {
						name: copy.name,
					})}
				>
					<ContextMenuItem icon={<Settings2 />} onSelect={() => onManage('workingCopy', copy.id, copy.name)}>
						{t('workspaceNavigation.nameAndGroup')}
					</ContextMenuItem>
					<ContextMenuItem
						icon={<Star fill={copy.favorite ? 'currentColor' : 'none'} />}
						onSelect={() => {
							void api.call('manage', { entity: 'workingCopy', id: copy.id, favorite: !copy.favorite }).then(onState).catch(notifyError);
						}}
					>
						{copy.favorite ? t('workspaceNavigation.unfavorite') : t('workspaceNavigation.favoriteWorkingCopy')}
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem icon={<RefreshCw />} onSelect={() => onRefresh(copy.id)}>
						{t('common.refreshLocalStatus')}
					</ContextMenuItem>
					<ContextMenuItem
						icon={<Terminal />}
						onSelect={() => {
							void api.call('system', { wcId: copy.id, path: '.', action: 'terminal' }).catch(notifyError);
						}}
					>
						{t('workspaceNavigation.openTerminal')}
					</ContextMenuItem>
					<ContextMenuSeparator />
					{(['up', 'down'] as const).map((direction) => (
						<ContextMenuItem
							key={direction}
							icon={direction === 'up' ? <ArrowUp /> : <ArrowDown />}
							disabled={direction === 'up' ? state.workingCopies[0]?.id === copy.id : state.workingCopies.at(-1)?.id === copy.id}
							onSelect={() => {
								void api.call('manage', { entity: 'workingCopy', id: copy.id, direction }).then(onState).catch(notifyError);
							}}
						>
							{direction === 'up' ? t('workspaceNavigation.moveUp') : t('workspaceNavigation.moveDown')}
						</ContextMenuItem>
					))}
				</ContextMenuContent>
			</ContextMenu>
		);
	}

	async function renameBookmark() {
		if (!editing?.name.trim()) {
			return;
		}
		try {
			onState(await api.call('bookmark', { ...editing.bookmark, name: editing.name }));
			setEditing(undefined);
			toast.success(t('workspaceNavigation.pathNameUpdated'));
		} catch (error) {
			notifyError(error);
		}
	}

	return (
		<>
			<div className="sidebar-head">
				<span>{t('workspaceNavigation.repositoriesAndWorkingCopies')}</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" aria-label={t('workspaceNavigation.addProject')} title={t('workspaceNavigation.addProject')}>
							<Plus />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuItem icon={<FolderGit2 />} shortcut="⌘O" onSelect={onAddCopy}>
							{t('workspaceNavigation.addExistingWorkingCopy')}
						</DropdownMenuItem>
						<DropdownMenuItem icon={<Cloud />} onSelect={() => onRemote()}>
							{t('workspaceNavigation.addRemoteRepository')}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem icon={<Plus />} onSelect={onGroup}>
							{t('workspaceNavigation.newGroup')}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="sidebar-search">
				<Search size={13} />
				<input
					aria-label={t('workspaceNavigation.searchProjectsAndPaths')}
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder={t('workspaceNavigation.searchNamesOrPaths')}
				/>
			</div>
			<nav className="navigation-scroll" aria-label={t('workspaceNavigation.repositoryNavigation')}>
				{state.workingCopies.some((copy) => copy.favorite) && (
					<>
						<div className="nav-section">
							<Star size={11} />
							<span>{t('workspaceNavigation.favorites')}</span>
						</div>
						{state.workingCopies.filter((copy) => copy.favorite && matches(`${copy.name} ${copy.path} ${copy.url}`)).map((copy) => copyRow(copy, true))}
					</>
				)}
				{[
					{
						id: '',
						name: t('dialogs.repository'),
					},
					...state.groups,
				].map((group) => {
					const repositories = state.repositories.filter(
						(repo) =>
							(repo.groupId ?? '') === group.id ||
							state.workingCopies.some((copy) => copy.repositoryId === repo.id && (copy.groupId ?? repo.groupId ?? '') === group.id),
					);
					return (
						<div className="nav-group" key={group.id}>
							{group.id ? (
								<ContextMenu>
									<ContextMenuTrigger asChild>
										<div
											className="nav-section"
											role="heading"
											aria-level={2}
											tabIndex={0}
											aria-label={t('workspaceNavigation.group', {
												name: group.name,
											})}
										>
											<span>{group.name}</span>
										</div>
									</ContextMenuTrigger>
									<ContextMenuContent
										aria-label={t('workspaceNavigation.group', {
											name: group.name,
										})}
									>
										<ContextMenuItem icon={<Settings2 />} onSelect={() => onManage('group', group.id, group.name)}>
											{t('workspaceNavigation.manageGroup')}
										</ContextMenuItem>
										<ContextMenuSeparator />
										{(['up', 'down'] as const).map((direction) => (
											<ContextMenuItem
												key={direction}
												icon={direction === 'up' ? <ArrowUp /> : <ArrowDown />}
												disabled={direction === 'up' ? state.groups[0]?.id === group.id : state.groups.at(-1)?.id === group.id}
												onSelect={() => {
													void api.call('manage', { entity: 'group', id: group.id, direction }).then(onState).catch(notifyError);
												}}
											>
												{direction === 'up' ? t('workspaceNavigation.moveUp') : t('workspaceNavigation.moveDown')}
											</ContextMenuItem>
										))}
									</ContextMenuContent>
								</ContextMenu>
							) : (
								<div className="nav-section">
									<span>{group.name}</span>
								</div>
							)}
							{repositories.map((repo) => {
								const matchRepository = matches(`${repo.name} ${repo.rootUrl} ${group.name}`);
								const copies = state.workingCopies.filter(
									(copy) =>
										copy.repositoryId === repo.id &&
										(copy.groupId ?? repo.groupId ?? '') === group.id &&
										(matchRepository || matches(`${copy.name} ${copy.path} ${copy.url}`)),
								);
								const bookmarks =
									(repo.groupId ?? '') === group.id
										? state.bookmarks.filter(
												(bookmark) => bookmark.repositoryId === repo.id && (matchRepository || matches(`${bookmark.name} ${bookmark.url}`)),
											)
										: [];
								if (!matchRepository && !copies.length && !bookmarks.length) {
									return null;
								}
								const key = `${group.id}:${repo.id}`;
								const expanded = query || !collapsed.includes(key);
								return (
									<section className="repository-node" key={repo.id}>
										<ContextMenu>
											<ContextMenuTrigger asChild>
												<div className={`repository-row ${activeRepositoryId === repo.id && (!activeUrl || activeUrl === repo.rootUrl) ? 'active' : ''}`}>
													<button
														className="repository-disclosure"
														aria-label={`${expanded ? t('fileTreeName.collapse') : t('fileTreeName.expand')} ${repo.name}`}
														aria-expanded={!!expanded}
														onClick={() => setCollapsed(expanded ? [...collapsed, key] : collapsed.filter((id) => id !== key))}
													>
														<ChevronRight size={12} className={expanded ? 'rotated' : ''} />
													</button>
													<button
														className="repository-name"
														aria-label={t('workspaceNavigation.browseRepository', {
															name: repo.name,
														})}
														title={repo.rootUrl}
														onClick={() => onRemote(repo.id)}
													>
														<Cloud size={15} />
														<span>{repo.name}</span>
													</button>
												</div>
											</ContextMenuTrigger>
											<ContextMenuContent
												aria-label={t('workspaceNavigation.repository', {
													name: repo.name,
												})}
											>
												<ContextMenuItem icon={<Cloud />} onSelect={() => onRemote(repo.id)}>
													{t('workspaceNavigation.browseRemotePath')}
												</ContextMenuItem>
												<ContextMenuItem icon={<Settings2 />} onSelect={() => onManage('repository', repo.id, repo.name)}>
													{t('workspaceNavigation.nameAndGroup')}
												</ContextMenuItem>
												{new URL(repo.rootUrl).protocol !== 'file:' && (
													<ContextMenuItem icon={<KeyRound />} onSelect={() => onAuthenticate(repo.rootUrl, repo.id)}>
														{t('workspace.connectionCredentials')}
													</ContextMenuItem>
												)}
												{findCredential(state.credentials, repo.rootUrl, repo.credentialId) && (
													<ContextMenuItem icon={<KeyRound />} destructive onSelect={() => void forgetAuthentication(repo.rootUrl, repo.credentialId)}>
														{t('workspaceNavigation.forgetConnectionCredentials')}
													</ContextMenuItem>
												)}
												<ContextMenuSeparator />
												{(['up', 'down'] as const).map((direction) => (
													<ContextMenuItem
														key={direction}
														icon={direction === 'up' ? <ArrowUp /> : <ArrowDown />}
														disabled={direction === 'up' ? state.repositories[0]?.id === repo.id : state.repositories.at(-1)?.id === repo.id}
														onSelect={() => {
															void api.call('manage', { entity: 'repository', id: repo.id, direction }).then(onState).catch(notifyError);
														}}
													>
														{direction === 'up' ? t('workspaceNavigation.moveUp') : t('workspaceNavigation.moveDown')}
													</ContextMenuItem>
												))}
											</ContextMenuContent>
										</ContextMenu>
										{expanded && (
											<div className="repository-children">
												{bookmarks.map((bookmark) => (
													<ContextMenu key={bookmark.id}>
														<ContextMenuTrigger asChild disabled={editing?.bookmark.id === bookmark.id}>
															<div className={`remote-bookmark ${activeRepositoryId === repo.id && activeUrl === bookmark.url ? 'active' : ''}`}>
																{editing?.bookmark.id === bookmark.id ? (
																	<input
																		aria-label={t('workspaceNavigation.pathBookmarkName')}
																		autoFocus
																		value={editing.name}
																		onChange={(event) => setEditing({ ...editing, name: event.target.value })}
																		onKeyDown={(event) => {
																			if (event.key === 'Enter') {
																				void renameBookmark();
																			} else if (event.key === 'Escape') {
																				setEditing(undefined);
																			}
																		}}
																	/>
																) : (
																	<button title={bookmark.url} onClick={() => onRemote(repo.id, bookmark.url)}>
																		<Folder size={13} />
																		<span>{bookmark.name}</span>
																		<small>{t('workspaceNavigation.remote')}</small>
																	</button>
																)}
															</div>
														</ContextMenuTrigger>
														<ContextMenuContent
															aria-label={t('workspaceNavigation.remotePath', {
																name: bookmark.name,
															})}
															onCloseAutoFocus={(event) => {
																const target = renameAfterClose.current;
																if (target?.id === bookmark.id) {
																	event.preventDefault();
																	renameAfterClose.current = undefined;
																	setEditing({ bookmark: target, name: target.name });
																}
															}}
														>
															<ContextMenuItem
																icon={<Pencil />}
																onSelect={() => {
																	renameAfterClose.current = bookmark;
																}}
															>
																{t('workspaceNavigation.renamePath')}
															</ContextMenuItem>
															{(['up', 'down'] as const).map((direction) => (
																<ContextMenuItem
																	key={direction}
																	icon={direction === 'up' ? <ArrowUp /> : <ArrowDown />}
																	disabled={direction === 'up' ? bookmarks[0]?.id === bookmark.id : bookmarks.at(-1)?.id === bookmark.id}
																	onSelect={() => {
																		void api
																			.call('bookmark', { ...bookmark, direction })
																			.then(onState)
																			.catch(notifyError);
																	}}
																>
																	{direction === 'up' ? t('workspaceNavigation.moveUp') : t('workspaceNavigation.moveDown')}
																</ContextMenuItem>
															))}
															<ContextMenuSeparator />
															<ContextMenuItem
																icon={<Trash2 />}
																destructive
																onSelect={() => {
																	void api
																		.call('bookmark', { ...bookmark, remove: true })
																		.then((next) => {
																			onState(next);
																			toast.success(t('workspaceNavigation.pathBookmarkRemoved'));
																		})
																		.catch(notifyError);
																}}
															>
																{t('workspaceNavigation.removePathBookmark')}
															</ContextMenuItem>
														</ContextMenuContent>
													</ContextMenu>
												))}
												{copies.map((copy) => copyRow(copy))}
												{!copies.length && !bookmarks.length && (
													<button className="repository-empty" onClick={() => onRemote(repo.id)}>
														{t('workspaceNavigation.browsePathAndCheckOut')}
													</button>
												)}
											</div>
										)}
									</section>
								);
							})}
						</div>
					);
				})}
				{!state.repositories.length && (
					<button className="sidebar-add" onClick={onAddCopy}>
						<Plus size={18} />
						<span>{t('workspaceNavigation.addAWorkingCopyOrRemoteRepository')}</span>
					</button>
				)}
			</nav>
		</>
	);
}
