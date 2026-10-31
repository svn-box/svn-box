import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { AppUpdateState } from '../../../shared/app-updates';
import type { useAppUpdate } from '../queries/use-app-update';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

type Updates = ReturnType<typeof useAppUpdate>;

function DownloadProgress({ state }: { state: AppUpdateState }) {
	const { t } = useTranslation();
	const percent = state.total ? Math.min(100, Math.max(0, Math.floor(((state.received ?? 0) / state.total) * 100))) : state.percent;
	return (
		<svg
			className={`app-update-ring ${percent === undefined ? 'spin' : ''}`}
			viewBox="0 0 20 20"
			role="progressbar"
			aria-label={t('appUpdate.progress')}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={percent}
		>
			<circle className="app-update-track" cx="10" cy="10" r="7.5" />
			<circle cx="10" cy="10" r="7.5" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - (percent ?? 25)} transform="rotate(-90 10 10)" />
		</svg>
	);
}

export function AppUpdateButton({ updates }: { updates: Updates }) {
	const { t } = useTranslation();
	const { phase, percent } = updates.state;
	const working = ['checking', 'verifying', 'installing'].includes(phase);
	const key = phase === 'downloading' && percent === undefined ? 'downloadingUnknown' : phase;
	const label = t(`appUpdate.${key}`, { percent: Math.floor(percent ?? 0) });
	return (
		<Button
			className="app-update-button"
			data-update-phase={phase}
			variant={phase === 'downloaded' ? 'default' : 'ghost'}
			size="sm"
			onClick={updates.activate}
			title={label}
			aria-label={label}
		>
			{phase === 'downloading' ? (
				<DownloadProgress state={updates.state} />
			) : working ? (
				<LoaderCircle className="spin" aria-hidden="true" />
			) : phase === 'error' ? (
				<CircleAlert aria-hidden="true" />
			) : phase === 'current' ? (
				<Check aria-hidden="true" />
			) : (
				<Download aria-hidden="true" />
			)}
			{t(phase === 'downloaded' ? 'appUpdate.readyButton' : 'appUpdate.softwareUpdate')}
		</Button>
	);
}

export function AppUpdateDialog({ updates, busy }: { updates: Updates; busy: boolean }) {
	const { t } = useTranslation();
	const dialog = useRef<HTMLDivElement>(null);
	const { state } = updates;
	const ready = state.phase === 'downloaded';
	const downloading = state.phase === 'downloading';
	const preparing = ['checking', 'verifying'].includes(state.phase);
	const installing = updates.installing || state.phase === 'installing';
	const key = downloading && state.percent === undefined ? 'downloadingUnknown' : state.phase;
	const title = ready ? t('appUpdate.readyTitle', { version: state.version }) : t(`appUpdate.${key}`, { percent: Math.floor(state.percent ?? 0) });
	const description = ready ? t('appUpdate.readyHint') : downloading ? t('appUpdate.backgroundHint') : t('appUpdate.checkHint');
	const message = updates.error || (state.messageKey ? t(state.messageKey) : state.message);
	return (
		<Dialog open={updates.open} onOpenChange={(open) => !open && updates.close()}>
			<DialogContent
				ref={dialog}
				className="app-update-dialog"
				showCloseButton={false}
				tabIndex={-1}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					dialog.current?.focus({ preventScroll: true });
				}}
			>
				<header className="app-update-summary">
					<RefreshCw aria-hidden="true" />
					<div>
						<DialogTitle>{title}</DialogTitle>
						<DialogDescription>{description}</DialogDescription>
					</div>
				</header>
				<p className="muted">{t('appUpdate.currentVersion', { version: state.currentVersion })}</p>
				{downloading && (
					<div className="app-update-download">
						<DownloadProgress state={state} />
						<span>
							{t('appUpdate.downloadSize', { received: ((state.received ?? 0) / 1048576).toFixed(1), total: state.total ? (state.total / 1048576).toFixed(1) : '—' })}
						</span>
					</div>
				)}
				{message && (
					<p className={state.phase === 'disabled' ? 'muted' : 'app-update-error'} role={state.phase === 'disabled' ? 'status' : 'alert'}>
						{message}
					</p>
				)}
				{ready && busy && <p className="muted">{t('updates.busy')}</p>}
				{state.notes && (
					<details className="app-update-notes">
						<summary>{t('appUpdate.releaseNotes')}</summary>
						<p>{state.notes}</p>
					</details>
				)}
				<footer className="app-update-actions">
					{state.version && (
						<Button variant="ghost" disabled={installing} onClick={() => void updates.release()}>
							{t('appUpdate.releasePage')}
						</Button>
					)}
					<Button variant="outline" disabled={installing} onClick={updates.close}>
						{t('appUpdate.later')}
					</Button>
					{ready || installing ? (
						<Button disabled={installing || busy} aria-busy={installing || undefined} onClick={() => void updates.install()}>
							{t(installing ? 'appUpdate.installing' : 'appUpdate.restartUpdate')}
						</Button>
					) : downloading || preparing ? (
						<Button variant="outline" onClick={() => void updates.cancel()}>
							{t('appUpdate.cancel')}
						</Button>
					) : (
						<Button disabled={state.phase === 'disabled'} onClick={() => void updates.check()}>
							{t('appUpdate.retry')}
						</Button>
					)}
				</footer>
			</DialogContent>
		</Dialog>
	);
}
