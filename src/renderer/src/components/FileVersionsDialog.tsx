import { useRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FileDiff, LoaderCircle, RotateCcw, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { Review, RevisionRange, RpcMap } from '../../../shared/types';
import { formatDateTime } from '../../../shared/i18n/format';
import { api, errorText } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { useStatus } from '../queries/hooks';
import { svnQueries } from '../queries/runtime';
import { acceptOperation } from '../queries/runtime';
import { Modal, ReviewDialog } from './Dialogs';
import { DiffView } from './DiffView';
import { Button } from './ui/button';
import { Select } from './ui/select';

export function useFileReview(wcId: string, path: string, onDone?: () => void) {
	const { t } = useTranslation();
	const [review, setReview] = useState<Review>();
	const [preparing, setPreparing] = useState(false);
	const request = useRef<AbortController | undefined>(undefined);
	useEffect(() => () => request.current?.abort(), []);

	async function prepare(action: Review['action'], options: Partial<RpcMap['review']['input']> = {}) {
		if (request.current) {
			return;
		}
		const controller = new AbortController();
		request.current = controller;
		setPreparing(true);
		const toastId = toast.loading(t('fileVersions.loading'));
		try {
			const next = await api.call('review', { ...options, wcId, paths: [path], action }, { signal: controller.signal });
			if (!controller.signal.aborted) {
				setReview(next);
			}
		} catch (error) {
			notifyError(error);
		} finally {
			toast.dismiss(toastId);
			request.current = undefined;
			setPreparing(false);
		}
	}

	async function execute() {
		if (!review) {
			return;
		}
		try {
			acceptOperation(await api.call('execute', { reviewId: review.id }));
			setReview(undefined);
			onDone?.();
		} catch (error) {
			notifyError(error);
			setReview(undefined);
		}
	}

	return {
		preparing,
		prepare,
		stop: () => request.current?.abort(),
		dialog: review ? <ReviewDialog review={review} onClose={() => setReview(undefined)} onExecute={execute} /> : undefined,
	};
}

export function FileVersionsDialog({ wcId, path, revision, onClose }: { wcId: string; path: string; revision?: number; onClose: () => void }) {
	const { t } = useTranslation();
	const client = useQueryClient();
	const [from, setFrom] = useState(String(revision ?? ''));
	const [to, setTo] = useState(String(revision ?? ''));
	const [toWorking, setToWorking] = useState(true);
	const [range, setRange] = useState<RevisionRange>();
	const [stopped, setStopped] = useState(false);
	const [backupId, setBackupId] = useState('');
	const review = useFileReview(wcId, path, onClose);
	const scan = useStatus(wcId).data?.scannedAt ?? '';
	const options = svnQueries.rangeDiffOptions(wcId, path, range ?? { from: 0, to: 'WORKING' }, scan);
	const query = useQuery({ ...options, enabled: !!range && !stopped });
	const info = useQuery(svnQueries.infoOptions(wcId, path, scan));
	const backups = useQuery(svnQueries.backupOptions(wcId, path));
	const controller = useRef<AbortController | undefined>(undefined);
	useEffect(() => () => controller.current?.abort(), []);
	const validFrom = /^\d+$/.test(from) && Number.isSafeInteger(Number(from));
	const validTo = toWorking || (/^\d+$/.test(to) && Number.isSafeInteger(Number(to)));

	function compare() {
		setStopped(false);
		const next = { from: Number(from), to: toWorking ? ('WORKING' as const) : Number(to) };
		if (JSON.stringify(next) === JSON.stringify(range)) {
			void query.refetch();
		} else {
			setRange(next);
		}
	}

	async function external() {
		if (!range || controller.current) {
			return;
		}
		const request = new AbortController();
		controller.current = request;
		const id = toast.loading(t('fileVersions.loading'));
		try {
			await api.call('compare', { wcId, path, range }, { signal: request.signal });
		} catch (error) {
			notifyError(error);
		} finally {
			controller.current = undefined;
			toast.dismiss(id);
		}
	}

	if (review.dialog) {
		return review.dialog;
	}
	return (
		<Modal title={t('fileVersions.title')} description={path} wide className="file-versions-dialog" onClose={onClose}>
			<div className="version-controls">
				<label>
					<span>{t('fileVersions.from')}</span>
					<input aria-label={t('fileVersions.fromLabel')} type="number" min="0" step="1" value={from} onChange={(event) => setFrom(event.target.value)} />
				</label>
				<ArrowRight size={16} aria-hidden="true" />
				<label>
					<span>{t('fileVersions.to')}</span>
					<Select
						value={toWorking ? 'working' : 'revision'}
						label={t('fileVersions.to')}
						options={[
							{ value: 'working', label: t('fileVersions.working') },
							{ value: 'revision', label: t('fileVersions.revision') },
						]}
						onValueChange={(value) => setToWorking(value === 'working')}
					/>
				</label>
				{!toWorking && <input aria-label={t('fileVersions.toLabel')} type="number" min="0" step="1" value={to} onChange={(event) => setTo(event.target.value)} />}
				<Button disabled={!validFrom || !validTo || query.isFetching} onClick={compare}>
					<FileDiff />
					{t('fileVersions.compare')}
				</Button>
				{query.isFetching && (
					<Button
						variant="ghost"
						onClick={() => {
							setStopped(true);
							void client.cancelQueries({ queryKey: options.queryKey, exact: true });
						}}
					>
						<Square />
						{t('fileVersions.stop')}
					</Button>
				)}
			</div>
			<p className="hint">{t('fileVersions.compareHint')}</p>
			<div className="version-diff">
				{range && !stopped ? (
					<DiffView
						title={`r${range.from} → ${range.to === 'WORKING' ? t('fileVersions.working') : `r${range.to}`}`}
						labels={{ left: `r${range.from}`, right: range.to === 'WORKING' ? t('fileVersions.working') : `r${range.to}` }}
						emptyMessage={t('fileVersions.noChanges')}
						text={query.data?.text ?? ''}
						loading={query.isFetching}
						error={query.error ? errorText(query.error) : undefined}
						unsupported={query.data?.unsupported}
						onCompare={path !== '.' ? () => void external() : undefined}
					/>
				) : (
					<div className="empty">
						<FileDiff size={24} />
						{t('fileVersions.empty')}
					</div>
				)}
			</div>
			<div className="version-recovery">
				<div>
					<strong>{t('operations.recover')}</strong>
					<p className="hint">{t('fileVersions.recoveryHint')}</p>
				</div>
				<Button
					variant="outline"
					disabled={!validFrom || Number(from) < 1 || info.data?.kind !== 'file' || review.preparing}
					onClick={() => void review.prepare('recover', { revision: Number(from) })}
				>
					<RotateCcw />
					{t('fileVersions.recover')}
				</Button>
			</div>
			<div className="version-backups">
				<strong>{t('fileVersions.backups')}</strong>
				{backups.isLoading ? (
					<LoaderCircle className="spin" size={14} />
				) : backups.error ? (
					<span className="error-text">{errorText(backups.error)}</span>
				) : backups.data?.length ? (
					<div className="version-backup-controls">
						<Select
							value={backupId || backups.data[0].id}
							onValueChange={setBackupId}
							label={t('fileVersions.backups')}
							options={backups.data.map((backup) => ({
								value: backup.id,
								label: formatDateTime(backup.createdAt),
								description: `${t(`operations.${backup.reason}`)} · ${t('fileVersions.backupSize', { bytes: backup.bytes })}`,
							}))}
						/>
						<Button variant="outline" disabled={review.preparing} onClick={() => void review.prepare('restore-backup', { backupId: backupId || backups.data?.[0].id })}>
							{t('fileVersions.restoreBackup')}
						</Button>
					</div>
				) : (
					<p className="hint">{t('fileVersions.noBackups')}</p>
				)}
			</div>
			<div className="dialog-footer">
				{review.preparing ? (
					<Button variant="outline" onClick={review.stop}>
						<Square />
						{t('fileVersions.stop')}
					</Button>
				) : (
					<Button variant="outline" onClick={onClose}>
						{t('fileVersions.cancel')}
					</Button>
				)}
			</div>
		</Modal>
	);
}
