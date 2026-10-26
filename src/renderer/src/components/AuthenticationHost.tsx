import { useTranslation } from 'react-i18next';
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
	useTranslation();
	const request = useSyncExternalStore(subscribeAuthentication, currentAuthentication);
	return request ? <AuthenticationDialog key={request.id} id={request.id} context={request.context} intent={request.intent} /> : null;
}

function AuthenticationDialog({ id, context, intent }: { id: string; context: AuthenticationContext; intent: AuthenticationIntent }) {
	const { t } = useTranslation();
	const editing = intent === 'edit';
	const [username, setUsername] = useState(context.username);
	const [password, setPassword] = useState('');
	const [rootUrl, setRootUrl] = useState(context.rootUrl);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(editing && !!context.credentialId);
	const actionLock = useRef(false);
	const passwordInput = useRef<HTMLInputElement>(null);
	const [error, setError] = useState(context.reason === 'rejected' ? t('authenticationHost.theServerRejectedTheseCredentialsEnterYourUsername') : '');
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
						setError(t('authenticationHost.noSavedPasswordWasFoundEnterItAgain'));
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
			toast.success(t('authenticationHost.credentialsSaved'));
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
				<aside className="authentication-identity" aria-label={t('authenticationHost.currentConnection')}>
					<Cloud aria-hidden="true" />
					<span className="authentication-protocol">
						{t('authenticationHost.connection', {
							value: address.protocol.slice(0, -1).toUpperCase(),
						})}
					</span>
					<strong title={connection}>{address.host || t('authenticationHost.localRepository')}</strong>
					<p className="authentication-path" title={context.url}>
						{readablePath(address.pathname) || '/'}
					</p>
					<div className="authentication-security">
						<ShieldCheck aria-hidden="true" />
						<p>
							{t('authenticationHost.passwordEncryptedOnThisMac')}
							<br />
							{t('authenticationHost.neverSharedWithOtherServers')}
						</p>
					</div>
				</aside>
				<div className="authentication-main">
					<header className="authentication-heading">
						<DialogTitle className="dialog-title">{t('authenticationHost.connectionCredentials')}</DialogTitle>
						<DialogDescription className="authentication-description">
							{editing ? t('authenticationHost.editCredentialsForThisConnection') : t('authenticationHost.signInWithYourSvnAccount')}
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
							<span>{t('authenticationHost.username')}</span>
							<input
								autoFocus={!context.username && !loading}
								autoComplete="username"
								value={username}
								disabled={busy || loading}
								onChange={(event) => setUsername(event.target.value)}
							/>
						</label>
						<label>
							<span>{t('authenticationHost.password')}</span>
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
								<span>{t('authenticationHost.authenticationOptions')}</span>
							</summary>
							<div className="authentication-options-body">
								<label>
									{t('authenticationHost.saveFor')}
									<Select
										label={t('authenticationHost.credentialScope')}
										value={rootUrl}
										disabled={busy || loading}
										options={roots.map((root) => ({
											value: root,
											label:
												root === connection
													? t('authenticationHost.allSubpathsOfThisConnection')
													: root === repository
														? t('authenticationHost.onlyThisRepositoryPath')
														: t('authenticationHost.currentlySavedPath'),
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
										{t('authenticationHost.useExistingSvnCredentials')}
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
								{t('common.cancel')}
							</Button>
							<Button
								className="authentication-primary"
								type="submit"
								disabled={busy || loading || !username.trim() || !password}
								aria-busy={busy || loading || undefined}
							>
								{(busy || loading) && <LoaderCircle className="spin" />}
								{busy ? t('authenticationHost.saving') : loading ? t('authenticationHost.reading') : t('common.save')}
							</Button>
						</footer>
					</form>
				</div>
			</DialogContent>
		</Dialog>
	);
}
