import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight, Cloud, LoaderCircle, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import type { AuthenticationContext } from '../../../shared/types';
import { credentialRoot, connectionRoot, svnAddress } from '../../../shared/auth';
import { currentAuthentication, finishAuthentication, subscribeAuthentication, type AuthenticationIntent } from '../lib/authentication';
import { errorText } from '../lib/api';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Select } from './ui/select';

function readablePath(path: string): string {
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

export function AuthenticationHost() {
	const request = useSyncExternalStore(subscribeAuthentication, currentAuthentication);
	return request ? <AuthenticationDialog key={request.id} id={request.id} context={request.context} intent={request.intent} /> : null;
}

function AuthenticationDialog({ id, context, intent }: { id: string; context: AuthenticationContext; intent: AuthenticationIntent }) {
	const editing = intent === 'edit';
	const [username, setUsername] = useState(context.username);
	const [password, setPassword] = useState('');
	const [rootUrl, setRootUrl] = useState(context.rootUrl);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(editing && !!context.credentialId);
	const actionLock = useRef(false);
	const passwordInput = useRef<HTMLInputElement>(null);
	const [error, setError] = useState(context.reason === 'rejected' ? '服务器未接受这份认证，请重新输入用户名和密码。' : '');
	const address = svnAddress(context.url);
	const connection = connectionRoot(context.url);
	const repository = credentialRoot(context.repositoryRoot ?? context.url);
	const roots = [...new Set([connection, repository, context.rootUrl])];

	useEffect(() => {
		if (!editing || !context.credentialId) {
			return;
		}
		let active = true;
		void window.svnbox
			.call('credentialForEdit', { id: context.credentialId, rootUrl: context.rootUrl, url: context.url })
			.then((value) => {
				if (active) {
					setUsername(value.username);
					setPassword(value.password);
					if (!value.password) {
						setError('未找到已保存的密码，请重新输入。');
					}
				}
			})
			.catch((error) => {
				if (active) {
					setError(errorText(error));
				}
			})
			.finally(() => {
				if (active) {
					setLoading(false);
				}
			});
		return () => {
			active = false;
		};
	}, [editing, context.credentialId, context.rootUrl, context.url]);

	useEffect(() => {
		if (!loading && context.username) {
			passwordInput.current?.focus();
		}
	}, [loading, context.username]);

	const close = () => {
		if (!actionLock.current) {
			setPassword('');
			finishAuthentication(id, true);
		}
	};

	async function save() {
		if (!username.trim() || !password || actionLock.current || loading) {
			return;
		}
		actionLock.current = true;
		setBusy(true);
		setError('');
		try {
			const state = await window.svnbox.call('credential', {
				rootUrl,
				url: context.url,
				username,
				password,
				id: rootUrl === context.rootUrl ? context.credentialId : undefined,
			});
			setPassword('');
			window.dispatchEvent(new CustomEvent('svnbox:authentication-changed', { detail: state }));
			toast.success('认证已保存');
			finishAuthentication(id);
		} catch (error) {
			setError(errorText(error));
		} finally {
			actionLock.current = false;
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && close()}>
			<DialogContent className="authentication-dialog" overlayClassName="authentication-overlay">
				<aside className="authentication-identity" aria-label="当前连接">
					<Cloud aria-hidden="true" />
					<span className="authentication-protocol">{address.protocol.slice(0, -1).toUpperCase()} 连接</span>
					<strong title={connection}>{address.host || '本地仓库'}</strong>
					<p className="authentication-path" title={context.url}>
						{readablePath(address.pathname) || '/'}
					</p>
					<div className="authentication-security">
						<ShieldCheck aria-hidden="true" />
						<p>
							密码在本机加密保存
							<br />
							其他服务器不会共用
						</p>
					</div>
				</aside>
				<div className="authentication-main">
					<header className="authentication-heading">
						<DialogTitle className="dialog-title">连接认证</DialogTitle>
						<DialogDescription className="authentication-description">
							{editing ? '编辑此连接的认证' : '使用 SVN 账号登录'}
							<span className="sr-only">：{context.url}</span>
						</DialogDescription>
					</header>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						<label>
							<span>用户名</span>
							<input
								autoFocus={!context.username && !loading}
								autoComplete="username"
								value={username}
								disabled={busy || loading}
								onChange={(event) => setUsername(event.target.value)}
							/>
						</label>
						<label>
							<span>密码</span>
							<input
								ref={passwordInput}
								type="password"
								autoFocus={!!context.username && !loading}
								autoComplete="current-password"
								value={password}
								disabled={busy || loading}
								onChange={(event) => setPassword(event.target.value)}
							/>
						</label>
						<details className="authentication-options">
							<summary>
								<ChevronRight aria-hidden="true" />
								<span>认证选项</span>
							</summary>
							<div className="authentication-options-body">
								<label>
									保存范围
									<Select
										label="认证适用范围"
										value={rootUrl}
										disabled={busy || loading}
										options={roots.map((root) => ({
											value: root,
											label: root === connection ? '此连接的所有子路径' : root === repository ? '仅当前仓库路径' : '当前已保存的路径',
											description: root,
										}))}
										onValueChange={setRootUrl}
									/>
								</label>
								{!editing && !context.credentialId && (
									<Button
										className="authentication-cache"
										variant="ghost"
										size="sm"
										type="button"
										disabled={busy}
										onClick={() => finishAuthentication(id, false, 'existing')}
									>
										使用 SVN 已有认证缓存
									</Button>
								)}
							</div>
						</details>
						{error && (
							<p className="authentication-error" role="alert">
								{error.split('\n')[0]}
							</p>
						)}
						<footer className="authentication-footer">
							<Button className="authentication-secondary" type="button" variant="outline" disabled={busy} onClick={close}>
								取消
							</Button>
							<Button
								className="authentication-primary"
								type="submit"
								disabled={busy || loading || !username.trim() || !password}
								aria-busy={busy || loading || undefined}
							>
								{(busy || loading) && <LoaderCircle className="spin" />}
								{busy ? '保存中…' : loading ? '读取中…' : '保存'}
							</Button>
						</footer>
					</form>
				</div>
			</DialogContent>
		</Dialog>
	);
}
