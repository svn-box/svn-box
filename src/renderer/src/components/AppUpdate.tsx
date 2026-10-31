import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, CircleAlert, Download, LoaderCircle } from 'lucide-react';
import appIcon from '../assets/app-icon.webp';
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
	if (!['downloading', 'verifying', 'downloaded', 'installing'].includes(phase) && !(phase === 'error' && updates.state.version)) {
		return null;
	}
	const key = phase === 'downloading' && percent === undefined ? 'downloadingUnknown' : phase;
	const label = t(phase === 'error' ? 'appUpdate.retryHint' : `appUpdate.${key}`, { percent: Math.floor(percent ?? 0) });
	const caption =
		phase === 'downloaded'
			? 'readyButton'
			: phase === 'downloading'
				? 'downloadingButton'
				: phase === 'verifying'
					? 'verifyingButton'
					: phase === 'error'
						? 'retryButton'
						: 'installing';
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
			) : phase === 'downloaded' ? (
				<Download aria-hidden="true" />
			) : phase === 'error' ? (
				<CircleAlert aria-hidden="true" />
			) : (
				<LoaderCircle className="spin" aria-hidden="true" />
			)}
			{t(`appUpdate.${caption}`)}
		</Button>
	);
}

export function AppUpdateDialog({ updates, busy }: { updates: Updates; busy: boolean }) {
	const { t, i18n } = useTranslation();
	const dialog = useRef<HTMLDivElement>(null);
	const { state } = updates;
	const ready = state.phase === 'downloaded';
	const downloading = state.phase === 'downloading';
	const preparing = ['checking', 'verifying'].includes(state.phase);
	const installing = updates.installing || state.phase === 'installing';
	const failed = state.phase === 'error' || Boolean(updates.error);
	const finished = state.phase === 'current' && !failed;
	const key = downloading && state.percent === undefined ? 'downloadingUnknown' : state.phase;
	const title = ready
		? t('appUpdate.readyTitle', { version: state.version })
		: failed
			? t('appUpdate.error')
			: t(`appUpdate.${key}`, { percent: Math.floor(state.percent ?? 0) });
	const message = updates.error || (state.messageKey ? t(state.messageKey) : state.message);
	const publishedAt = new Date(state.publishedAt ?? Number.NaN);
	const publishedDate = Number.isNaN(publishedAt.getTime())
		? undefined
		: new Intl.DateTimeFormat(i18n.resolvedLanguage, { year: 'numeric', month: 'long', day: 'numeric' }).format(publishedAt);
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
					<img className="app-update-icon" src={appIcon} alt="" width={44} height={44} />
					<div>
						<DialogTitle>{title}</DialogTitle>
						{publishedDate && (
							<p className="app-update-date">
								<CalendarDays size={13} aria-hidden="true" />
								<time dateTime={publishedAt.toISOString()}>{publishedDate}</time>
							</p>
						)}
					</div>
				</header>
				<DialogDescription className="sr-only">{t('appUpdate.currentVersion', { version: state.currentVersion })}</DialogDescription>
				{downloading && (
					<div className="app-update-download">
						<DownloadProgress state={state} />
						<span>
							{t('appUpdate.downloadSize', { received: ((state.received ?? 0) / 1048576).toFixed(1), total: state.total ? (state.total / 1048576).toFixed(1) : '—' })}
						</span>
					</div>
				)}
				{message && (
					<p className={state.phase === 'disabled' ? 'app-update-hint' : 'app-update-error'} role={state.phase === 'disabled' ? 'status' : 'alert'}>
						{state.phase !== 'disabled' && <CircleAlert size={15} aria-hidden="true" />}
						{message}
					</p>
				)}
				{ready && busy && <p className="app-update-hint">{t('updates.busy')}</p>}
				<footer className="app-update-actions">
					<Button variant="outline" disabled={installing} onClick={updates.close}>
						{t(finished || (!state.version && !preparing) ? 'common.close' : 'appUpdate.later')}
					</Button>
					{ready || installing ? (
						<Button disabled={installing || busy} aria-busy={installing || undefined} onClick={() => void updates.install()}>
							{t(installing ? 'appUpdate.installing' : 'appUpdate.restartUpdate')}
						</Button>
					) : downloading || preparing ? (
						<Button variant="outline" onClick={() => void updates.cancel()}>
							{t(state.phase === 'checking' ? 'appUpdate.cancelCheck' : 'appUpdate.cancel')}
						</Button>
					) : !finished ? (
						<Button disabled={state.phase === 'disabled'} onClick={() => void updates.check()}>
							{t('appUpdate.retry')}
						</Button>
					) : null}
				</footer>
			</DialogContent>
		</Dialog>
	);
}
