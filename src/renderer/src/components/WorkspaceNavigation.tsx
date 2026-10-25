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
	const [search, setSearch] = useState('');
	const [collapsed, setCollapsed] = useState<string[]>([]);
	const [editing, setEditing] = useState<{ bookmark: RemoteBookmark; name: string }>();
	const renameAfterClose = useRef<RemoteBookmark | undefined>(undefined);
	const query = search.trim().toLocaleLowerCase();
	const matches = (text: string) => !query || text.toLocaleLowerCase().includes(query);

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
							aria-label={`${copy.name} ${copy.url.split('/').at(-1) || '/'} · 本地工作副本`}
							title={`${copy.path}\n${copy.url}\n最近扫描：${copy.lastScan ? new Date(copy.lastScan).toLocaleString('zh-CN') : '尚未扫描'}`}
							onClick={() => onActivate(copy.id)}
						>
							<span className={`project-icon ${copy.error ? 'invalid' : ''}`}>{copy.error ? <CircleAlert size={15} /> : <FolderGit2 size={15} />}</span>
							<span className="nav-copy-text">
								<strong>{copy.name}</strong>
								<small>{copy.error ? '路径或连接异常' : location}</small>
							</span>
							{running ? (
								<LoaderCircle size={12} className="spin" />
							) : copy.conflicts ? (
								<span className="conflict-count" title={`${copy.conflicts} 个冲突`}>
									! {copy.conflicts}
								</span>
							) : (
								<span className="nav-count">{copy.changeCount ?? '—'}</span>
							)}
						</button>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent aria-label={`工作副本 ${copy.name}`}>
					<ContextMenuItem icon={<Settings2 />} onSelect={() => onManage('workingCopy', copy.id, copy.name)}>
						名称与分组…
					</ContextMenuItem>
					<ContextMenuItem
						icon={<Star fill={copy.favorite ? 'currentColor' : 'none'} />}
						onSelect={() => {
							void api.call('manage', { entity: 'workingCopy', id: copy.id, favorite: !copy.favorite }).then(onState).catch(notifyError);
						}}
					>
						{copy.favorite ? '取消收藏' : '收藏工作副本'}
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem icon={<RefreshCw />} onSelect={() => onRefresh(copy.id)}>
						刷新本地状态
					</ContextMenuItem>
					<ContextMenuItem
						icon={<Terminal />}
						onSelect={() => {
							void api.call('system', { wcId: copy.id, path: '.', action: 'terminal' }).catch(notifyError);
						}}
					>
						打开终端
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
							{direction === 'up' ? '上移' : '下移'}
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
			toast.success('路径名称已更新');
		} catch (error) {
			notifyError(error);
		}
	}

	return (
		<>
			<div className="sidebar-head">
				<span>仓库与工作副本</span>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" aria-label="添加项目" title="添加项目">
							<Plus />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuItem icon={<FolderGit2 />} shortcut="⌘O" onSelect={onAddCopy}>
							添加已有工作副本…
						</DropdownMenuItem>
						<DropdownMenuItem icon={<Cloud />} onSelect={() => onRemote()}>
							添加远端仓库…
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem icon={<Plus />} onSelect={onGroup}>
							新建分组…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="sidebar-search">
				<Search size={13} />
				<input aria-label="搜索项目与路径" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索名称或路径…" />
			</div>
			<nav className="navigation-scroll" aria-label="仓库导航">
				{state.workingCopies.some((copy) => copy.favorite) && (
					<>
						<div className="nav-section">
							<Star size={11} />
							<span>收藏</span>
						</div>
						{state.workingCopies.filter((copy) => copy.favorite && matches(`${copy.name} ${copy.path} ${copy.url}`)).map((copy) => copyRow(copy, true))}
					</>
				)}
				{[{ id: '', name: '仓库' }, ...state.groups].map((group) => {
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
										<div className="nav-section" role="heading" aria-level={2} tabIndex={0} aria-label={`分组 ${group.name}`}>
											<span>{group.name}</span>
										</div>
									</ContextMenuTrigger>
									<ContextMenuContent aria-label={`分组 ${group.name}`}>
										<ContextMenuItem icon={<Settings2 />} onSelect={() => onManage('group', group.id, group.name)}>
											管理分组…
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
												{direction === 'up' ? '上移' : '下移'}
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
														aria-label={`${expanded ? '收起' : '展开'} ${repo.name}`}
														aria-expanded={!!expanded}
														onClick={() => setCollapsed(expanded ? [...collapsed, key] : collapsed.filter((id) => id !== key))}
													>
														<ChevronRight size={12} className={expanded ? 'rotated' : ''} />
													</button>
													<button className="repository-name" aria-label={`浏览仓库 ${repo.name}`} title={repo.rootUrl} onClick={() => onRemote(repo.id)}>
														<Cloud size={15} />
														<span>{repo.name}</span>
													</button>
												</div>
											</ContextMenuTrigger>
											<ContextMenuContent aria-label={`仓库 ${repo.name}`}>
												<ContextMenuItem icon={<Cloud />} onSelect={() => onRemote(repo.id)}>
													浏览远端路径
												</ContextMenuItem>
												<ContextMenuItem icon={<Settings2 />} onSelect={() => onManage('repository', repo.id, repo.name)}>
													名称与分组…
												</ContextMenuItem>
												{new URL(repo.rootUrl).protocol !== 'file:' && (
													<ContextMenuItem icon={<KeyRound />} onSelect={() => onAuthenticate(repo.rootUrl, repo.id)}>
														此连接的认证…
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
														{direction === 'up' ? '上移' : '下移'}
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
																		aria-label="路径书签名称"
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
																		<small>远端</small>
																	</button>
																)}
															</div>
														</ContextMenuTrigger>
														<ContextMenuContent
															aria-label={`远端路径 ${bookmark.name}`}
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
																重命名路径…
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
																	{direction === 'up' ? '上移' : '下移'}
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
																			toast.success('路径书签已移除');
																		})
																		.catch(notifyError);
																}}
															>
																移除路径书签
															</ContextMenuItem>
														</ContextMenuContent>
													</ContextMenu>
												))}
												{copies.map((copy) => copyRow(copy))}
												{!copies.length && !bookmarks.length && (
													<button className="repository-empty" onClick={() => onRemote(repo.id)}>
														浏览路径并检出…
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
						<span>添加工作副本或远端仓库</span>
					</button>
				)}
			</nav>
		</>
	);
}
