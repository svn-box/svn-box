import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { GitMerge, RefreshCw, Square } from 'lucide-react';
import { svnQueries } from '../queries/runtime';
import { errorText } from '../lib/api';
import { useFileReview } from './FileVersionsDialog';
import { Button } from './ui/button';
import { DiffView } from './DiffView';

export function TextConflictActions({ wcId, path, scan, sources }: { wcId: string; path: string; scan?: string; sources?: { baseRevision: string; incomingRevision: string } }) {
	const { t } = useTranslation();
	const merge = useQuery(svnQueries.mergeOptions(wcId, path, scan));
	const review = useFileReview(wcId, path, () => {
		void merge.refetch();
	});
	return (
		<>
			{sources && !merge.data && <p>{t('fileVersions.sources', { base: sources.baseRevision, incoming: sources.incomingRevision })}</p>}
			<Button variant="outline" size="sm" disabled={review.preparing} onClick={() => void review.prepare('resolve-local')}>
				{t('fileVersions.local')}
			</Button>
			<Button variant="outline" size="sm" disabled={review.preparing} onClick={() => void review.prepare('resolve-incoming')}>
				{t('fileVersions.incoming')}
			</Button>
			<Button variant="outline" size="sm" disabled={review.preparing} onClick={() => void review.prepare('merge')}>
				<GitMerge />
				{t('fileVersions.launchMerge')}
			</Button>
			<Button variant="outline" size="sm" disabled={merge.isFetching} onClick={() => void merge.refetch()}>
				<RefreshCw className={merge.isFetching ? 'spin' : ''} />
				{t('fileVersions.checkMerge')}
			</Button>
			{review.preparing && (
				<Button variant="ghost" size="sm" onClick={review.stop}>
					<Square />
					{t('fileVersions.stop')}
				</Button>
			)}
			{merge.error && <p className="error-text">{errorText(merge.error)}</p>}
			{merge.data && (
				<>
					<p>{t('fileVersions.sources', { base: merge.data.baseRevision, incoming: merge.data.incomingRevision })}</p>
					<p>{t(merge.data.hasResult && !merge.data.markers ? 'fileVersions.mergeReady' : 'fileVersions.mergeUnfinished')}</p>
					<Button
						size="sm"
						disabled={review.preparing || !merge.data.hasResult || merge.data.markers}
						onClick={() => void review.prepare('apply-merge', { mergeId: merge.data!.id })}
					>
						{t('fileVersions.applyMerge')}
					</Button>
					<details className="merge-preview">
						<summary>{t('workspace.viewBuiltInDiff')}</summary>
						<DiffView
							labels={{ left: t('fileVersions.current'), right: t('fileVersions.selected') }}
							emptyMessage={t('fileVersions.noChanges')}
							text={merge.data.preview.text}
							unsupported={merge.data.preview.unsupported}
							title={path}
						/>
					</details>
				</>
			)}
			<p>{t('fileVersions.manualHelp')}</p>
			{review.dialog}
		</>
	);
}
