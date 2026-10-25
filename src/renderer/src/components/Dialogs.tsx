import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronRight, Download, Folder, KeyRound, LoaderCircle, Plus, RefreshCw, Server, Settings2, ShieldCheck, Square, Star } from 'lucide-react';
import type { AppState, Detection, RemoteEntry, Review, RpcMap } from '../../../shared/types';
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

export function SettingsDialog({ state, onState, onClose }: { state: AppState; onState: (state: AppState) => void; onClose: () => void }) {
	const [path, setPath] = useState(state.settings.svnPath);
	const [tool, setTool] = useState(state.settings.mergeTool);
	const [detection, setDetection] = useState<Detection>();
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		void api
			.call('detect', {})
			.then(setDetection)
			.catch((error) => notifyError(error));
	}, []);
	async function save() {
		setBusy(true);
		try {
			onState(await api.call('settings', { svnPath: path, mergeTool: tool }));
			setDetection(await api.call('detect', { path }));
			toast.success('设置已保存');
		} catch (error) {
			notifyError(error);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal title="设置" description="本地 SVN 工具与界面外观" onClose={onClose}>
			<div className="settings-scroll">
				<div className="section-heading">
					<Settings2 size={15} />
					SVN 命令行工具
				</div>
				<label>
					可执行文件路径
					<input value={path} onChange={(event) => setPath(event.target.value)} placeholder="留空使用仓盒内置 SVN" />
				</label>
				<p className="hint">默认使用内置 SVN，包含服务器先发握手的连接兼容处理；也可指定自己的 SVN 工具。</p>
				<div className={`detection ${detection?.ok ? 'good' : 'error-text'}`}>
					<ShieldCheck size={15} />
					{detection ? (detection.ok ? `Subversion ${detection.version} · ${detection.path}` : detection.error) : '正在检测…'}
				</div>
				<label>
					外部合并工具
					<input value={tool} onChange={(event) => setTool(event.target.value)} placeholder="/Applications/Kaleidoscope.app" />
				</label>
				<p className="hint">通过外部工具打开冲突文件；保存后回到仓盒检查，再明确标记为已解决。</p>
				<div className="section-heading mt-5">外观</div>
				<div className="theme-options">
					{(['system', 'light', 'dark'] as const).map((theme) => (
						<button
							key={theme}
							className={state.settings.theme === theme ? 'chosen' : ''}
							onClick={() => {
								void api
									.call('settings', { theme })
									.then(onState)
									.catch((error) => notifyError(error));
							}}
						>
							<span className={`theme-preview ${theme}`}>
								<i />
								<i />
								<i />
							</span>
							{{ system: '跟随系统', light: '浅色', dark: '深色' }[theme]}
						</button>
					))}
				</div>
			</div>
			<div className="dialog-footer">
				<Button variant="outline" onClick={onClose}>
					关闭
				</Button>
				<Button disabled={busy} onClick={() => void save()}>
					{busy && <LoaderCircle className="spin" />}保存并检测
				</Button>
			</div>
		</Modal>
	);
}

function RemoteSurface({ children, title, description }: React.ComponentProps<typeof Modal>) {
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
	state: AppState;
	initialRepositoryId?: string;
	initialUrl?: string;
	embedded?: boolean;
	onLocationChange?: (url: string) => void;
	onRepositoryChange?: (id?: string) => void;
	onState: (state: AppState) => void;
	onClose: () => void;
}) {
	const initial = state.repositories.find((repo) => repo.id === initialRepositoryId);
	const [repositoryId, setRepositoryId] = useState(initial?.id ?? '');
	const [url, setUrl] = useState(initialUrl ?? initial?.rootUrl ?? '');
	const [loadedUrl, setLoadedUrl] = useState('');
	const [entries, setEntries] = useState<RemoteEntry[]>([]);
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
			const choice = await requestAuthentication(context, controller.signal);
			if (!controller.signal.aborted) {
				await browse(url, repositoryId, choice === 'existing');
			}
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
			const result = await api.call('list', { url: target, repositoryId: id || undefined }, { signal: controller.signal, useExistingAuthentication });
			if (version === request.current) {
				setEntries(result);
				setLoadedUrl(target);
				onLocationChange?.(target);
				setUrl(target);
				setFolder(decodeURIComponent(target.split('/').filter(Boolean).at(-1) || 'working-copy'));
			}
		} catch (error) {
			if (version === request.current) {
				if ((error as { kind?: string }).kind === 'cancelled') {
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
			toast.success('仓库书签已保存');
			const repo = next.repositories.find((repo) => url.startsWith(repo.rootUrl));
			if (repo) {
				setRepositoryId(repo.id);
				connection.current = undefined;
				await browse(url, repo.id);
			}
		} catch (error) {
			if (version === request.current) {
				if ((error as { kind?: string }).kind === 'cancelled') {
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
				throw new Error('请填写有效的目标文件夹名称');
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
				if ((error as { kind?: string }).kind === 'cancelled') {
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
		<Surface title="仓库浏览与检出" description="逐层浏览远端目录，检出为独立的本地工作副本" wide onClose={close}>
			<div className="remote-top">
				<Server size={18} />
				<Combobox
					label="仓库"
					value={repositoryId}
					options={[{ value: '', label: '添加新的仓库地址' }, ...state.repositories.map((repo) => ({ value: repo.id, label: repo.name, description: repo.rootUrl }))]}
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
							setEntries([]);
							setLoadedUrl('');
						}
					}}
				/>
			</div>
			<div className="input-action">
				<input
					aria-label="仓库 URL"
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
					{busy ? (activeAction === 'checkout' ? '取消检出' : '停止连接') : '浏览'}
				</Button>
				<Button variant="ghost" size="icon" aria-label="此连接的认证" title="此连接的认证" disabled={!url} onClick={() => void authenticate()}>
					<KeyRound />
				</Button>
			</div>
			{!repositoryId && (
				<div className="bookmark-form">
					<input value={name} onChange={(event) => setName(event.target.value)} placeholder="书签名称（可选）" />
					<Button variant="outline" disabled={busy || !url} onClick={() => void bookmark()}>
						<Plus />
						验证并保存书签
					</Button>
				</div>
			)}
			<div className="remote-path">
				<Button
					variant="ghost"
					size="icon"
					aria-label="上一级目录"
					disabled={!loadedUrl || loadedUrl === root || busy}
					onClick={() => {
						const target = new URL(loadedUrl);
						target.pathname = target.pathname.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/';
						void browse(target.href);
					}}
				>
					<ArrowLeft />
				</Button>
				<span className="truncate">{loadedUrl || '尚未连接仓库'}</span>
				<span className="muted">{entries.length} 项</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={!loadedUrl || !repositoryId || busy}
					title="将此远端路径保存到左侧仓库节点下"
					onClick={() => {
						const name = decodeURIComponent(loadedUrl.replace(/\/$/, '').split('/').at(-1) || '仓库根目录');
						void api
							.call('bookmark', { repositoryId, url: loadedUrl, name })
							.then((next) => {
								onState(next);
								toast.success('远端路径已保存到侧栏');
							})
							.catch(notifyError);
					}}
				>
					<Star />
					保存路径
				</Button>
			</div>
			<div className="remote-list">
				{busy ? (
					<div className="empty">
						<LoaderCircle className="spin" />
						{activeAction === 'checkout' ? '正在准备检出' : '正在连接仓库'}
						<span className="hint">可使用上方按钮停止，或重新输入连接认证。</span>
					</div>
				) : stopped ? (
					<div className="empty">
						<Square size={24} />
						<strong>连接已停止</strong>
						<span>可以修改地址或认证后重新连接。</span>
						<Button variant="outline" size="sm" onClick={() => void browse(url)}>
							重新连接
						</Button>
					</div>
				) : error ? (
					<div className="empty error-text">
						<Server size={24} />
						<strong>暂时无法连接仓库</strong>
						<span>{error.split('\n')[0]}</span>
						<Button variant="outline" size="sm" onClick={() => void browse(url)}>
							重新连接
						</Button>
					</div>
				) : !entries.length ? (
					<div className="empty">
						<Folder size={28} />
						此目录为空，或尚未浏览
					</div>
				) : (
					<VirtualList
						items={entries}
						label="远端目录"
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
					检出到父文件夹
					<div className="input-action">
						<input value={parent} onChange={(event) => setParent(event.target.value)} placeholder="选择本地文件夹" />
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
							选择…
						</Button>
					</div>
				</label>
				<div className="form-grid">
					<label>
						新文件夹名称
						<input value={folder} onChange={(event) => setFolder(event.target.value)} />
					</label>
					<label>
						检出深度
						<Select
							label="检出深度"
							value={depth}
							options={[
								{ value: 'infinity', label: '完整目录（递归）' },
								{ value: 'immediates', label: '直接子项' },
								{ value: 'files', label: '仅当前层文件' },
								{ value: 'empty', label: '空目录' },
							]}
							onValueChange={(value) => setDepth(value as typeof depth)}
						/>
					</label>
				</div>
				<p className="hint">目标文件夹必须尚不存在。首次检出跳过 externals，可将外部工作副本单独管理。取消后可能留下部分检出内容。</p>
			</div>
			<div className="dialog-footer">
				<Button variant="outline" onClick={close}>
					取消
				</Button>
				<Button disabled={!loadedUrl || !parent || !folder || busy || url !== loadedUrl} onClick={() => void checkout()}>
					<Download />
					检出此目录
				</Button>
			</div>
		</Surface>
	);
}

export function ReviewDialog({ review, onClose, onExecute }: { review: Review; onClose: () => void; onExecute: () => Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [checked, setChecked] = useState(false);
	const dangerous = ['revert', 'delete', 'resolve'].includes(review.action);
	const labels: Record<Review['action'], string> = {
		commit: '确认提交',
		update: '更新工作副本',
		add: '加入版本控制',
		rename: '确认重命名',
		delete: '删除磁盘内容',
		ignore: '设置忽略',
		revert: '还原所选变更',
		resolve: '标记为已解决',
		cleanup: '清理工作副本锁',
	};
	return (
		<Modal title={review.action === 'commit' ? '提交审阅' : '确认操作范围'} description="执行前将重新检查文件及属性；状态变化时必须重新审阅。" wide onClose={onClose}>
			<div className="review-summary">
				<span>{labels[review.action]}</span>
				<strong>{review.paths.length} 个明确目标</strong>
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
					items={review.paths.length ? review.paths : ['.（整个工作副本，跳过 externals）']}
					label="实际操作范围"
					height={30}
					render={(path) => (
						<div className="review-path">
							<span className="path-status">{review.requested.includes(path) ? '所选' : '关联'}</span>
							<code>{path}</code>
						</div>
					)}
				/>
			</div>
			{review.action === 'commit' && <p className="hint">仅提交上方列出的路径。关联的父目录、目录内容和移动两端会一并列出，请核对后确认。</p>}
			{dangerous && (
				<label className="confirm-check">
					<input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
					我已检查实际范围并理解上述影响
				</label>
			)}
			<div className="dialog-footer">
				<Button variant="outline" disabled={busy} onClick={onClose}>
					返回检查
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
