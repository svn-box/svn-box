import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { AppUpdateAction, AppUpdateState } from '../../../shared/app-updates';
import { isOperationActive } from '../../../shared/types';
import { api } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { useOperationSummary } from '../queries/hooks';
import { workspaceStore } from '../state/workspace';
import { Button } from './ui/button';

export function AppUpdateSection({ focusRequest = 0 }: { focusRequest?: number }) {
	const { t } = useTranslation();
	const [update, setUpdate] = useState<AppUpdateState>();
	const [pending, setPending] = useState(false);
	const section = useRef<HTMLDivElement>(null);
	const busy = useOperationSummary().some(isOperationActive);
	const phase = update?.phase;
	const working = pending || !update || ['checking', 'downloading', 'installing'].includes(phase ?? '');
	const download = phase === 'available' || (phase === 'error' && !!update?.version);
	const action = phase === 'downloaded' ? 'install' : download ? 'download' : 'check';
	const label =
		phase === 'checking'
			? t('appUpdateSection.checking')
			: phase === 'downloading'
				? t('appUpdateSection.downloading')
				: phase === 'installing'
					? t('appUpdateSection.restarting')
					: action === 'install'
						? t('appUpdateSection.restartAndInstall')
						: download
							? t('appUpdateSection.downloadUpdate')
							: t('desktop.checkForUpdates');
	const message =
		(update?.messageKey ? t(update.messageKey) : update?.message) ??
		(phase === 'current'
			? t('appUpdateSection.youReUpToDate')
			: phase === 'checking'
				? t('appUpdateSection.checkingForAvailableVersions')
				: phase === 'available'
					? t('appUpdateSection.newVersionAvailable', {
							value: update?.version,
						})
					: phase === 'downloaded'
						? busy
							? t('appUpdateSection.anSvnOperationIsRunningInstallTheUpdate')
							: t('appUpdateSection.versionIsDownloadedRestartToInstall', {
									value: update?.version,
								})
						: phase === 'downloading'
							? t('appUpdateSection.downloading2', {
									value: update?.version,
									value2: Math.round(update?.percent ?? 0),
								})
							: phase === 'installing'
								? t('appUpdateSection.preparingToInstallTheUpdate')
								: t('appUpdateSection.checkForNewVersionsManuallyThenDownloadAnd'));
	useEffect(() => {
		let active = true;

		const accept = (next: AppUpdateState) => {
			if (active) {
				setUpdate((previous) => (!previous || next.revision >= previous.revision ? next : previous));
			}
		};

		const unsubscribe = api.onAppUpdate(accept);
		void api.call('appUpdate', { action: 'status' }).then(accept).catch(notifyError);
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);
	useEffect(() => {
		if (focusRequest || (phase && !['idle', 'disabled', 'current'].includes(phase))) {
			section.current?.scrollIntoView({ block: 'nearest' });
		}
	}, [phase, focusRequest]);

	async function run(action: AppUpdateAction) {
		setPending(true);
		try {
			if (action === 'install') {
				await workspaceStore.getState().flushSessions();
			}
			const next = await api.call('appUpdate', { action });
			setUpdate((previous) => (!previous || next.revision >= previous.revision ? next : previous));
		} catch (error) {
			notifyError(error);
		} finally {
			setPending(false);
		}
	}

	return (
		<div className="settings-row settings-app-update" ref={section}>
			<div className="settings-row-copy">
				<h3>
					{t('appUpdateSection.appUpdates')}
					{update && (
						<span className="settings-app-version">
							{t('appUpdateSection.currentVersion', {
								currentVersion: update.currentVersion,
							})}
						</span>
					)}
				</h3>
				<p role="status" className={update?.message && phase !== 'disabled' ? 'error-text' : undefined}>
					{message}
				</p>
				{phase === 'downloading' && <progress aria-label={t('appUpdateSection.appUpdateDownloadProgress')} max={100} value={update?.percent ?? 0} />}
			</div>
			<div className="settings-update-actions">
				{update?.version && (
					<Button variant="ghost" size="sm" disabled={phase === 'installing'} onClick={() => void run('release')}>
						{t('appUpdateSection.releaseNotes')}
					</Button>
				)}
				<Button
					variant="outline"
					disabled={working || phase === 'disabled' || (action === 'install' && busy)}
					aria-busy={working || undefined}
					onClick={() => void run(action)}
				>
					{working ? <LoaderCircle className="spin" /> : download ? <Download /> : <RefreshCw />}
					{label}
				</Button>
			</div>
		</div>
	);
}
