import { useState, useSyncExternalStore } from 'react';
import { KeyRound, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { AuthenticationContext } from '../../../shared/types';
import { credentialRoot, connectionRoot } from '../../../shared/auth';
import { currentAuthentication, finishAuthentication, subscribeAuthentication } from '../lib/authentication';
import { errorText } from '../lib/api';
import { Modal } from './Dialogs';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';

export function AuthenticationHost() {
	const request = useSyncExternalStore(subscribeAuthentication, currentAuthentication);
	return request ? <AuthenticationDialog key={request.id} id={request.id} context={request.context} /> : null;
}

function AuthenticationDialog({ id, context }: { id: string; context: AuthenticationContext }) {
	const [username, setUsername] = useState(context.username);
	const [password, setPassword] = useState('');
	const [rootUrl, setRootUrl] = useState(context.rootUrl);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(context.reason === 'rejected' ? '服务器未接受这份认证，请重新输入用户名和密码。' : '');
	const roots = [...new Set([context.rootUrl, connectionRoot(context.url), credentialRoot(context.repositoryRoot ?? context.url)])];
	const close = () => {
		if (!busy) {
			finishAuthentication(id, true);
		}
	};

	async function save() {
		if (!username.trim() || !password || busy) {
			return;
		}
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
			setBusy(false);
		}
	}

	async function forget() {
		setBusy(true);
		try {
			const state = await window.svnbox.call('credential', { rootUrl: context.rootUrl, id: context.credentialId, username: '', password: '', remove: true });
			window.dispatchEvent(new CustomEvent('svnbox:authentication-changed', { detail: state }));
			toast.success('已忘记此连接的认证');
			finishAuthentication(id, true);
		} catch (error) {
			setError(errorText(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal title="连接认证" description="保存在本机，适用范围内的 SVN 子路径共用此认证。" onClose={close} className="authentication-dialog">
			<div className="authentication-address">
				<KeyRound size={16} />
				<span title={context.url}>{context.url}</span>
			</div>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<label>
					用户名
					<input autoFocus autoComplete="username" value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} />
				</label>
				<label>
					密码
					<input type="password" autoComplete="current-password" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
				</label>
				<label>
					认证适用范围
					<Combobox
						label="认证适用范围"
						value={rootUrl}
						disabled={busy}
						options={roots.map((root) => ({ value: root, label: root === connectionRoot(context.url) ? '此连接下的所有子路径' : '仅此仓库或路径', description: root }))}
						onValueChange={setRootUrl}
					/>
				</label>
				<p className="hint break-all">
					{rootUrl}
					<br />
					密码由 macOS 安全存储加密，其他连接不会使用这份认证。
				</p>
				{context.credentialId && (
					<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void forget()}>
						忘记此连接的认证
					</Button>
				)}
				{error && (
					<p className="authentication-error" role="alert">
						{error.split('\n')[0]}
					</p>
				)}
				<div className="dialog-footer">
					<Button type="button" variant="outline" disabled={busy} onClick={close}>
						取消
					</Button>
					{!context.credentialId && (
						<Button type="button" variant="outline" disabled={busy} onClick={() => finishAuthentication(id, false, 'existing')}>
							使用已有认证
						</Button>
					)}
					<Button type="submit" disabled={busy || !username.trim() || !password}>
						{busy && <LoaderCircle className="spin" />}保存并继续
					</Button>
				</div>
			</form>
		</Modal>
	);
}
