import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { RefreshCw, Square } from 'lucide-react';
import { useDiff } from '../queries/hooks';
import { DiffView } from './DiffView';
import { Button } from './ui/button';

export function HistoryComparison({
	wcId,
	path,
	revision,
	wholeCommit,
	onClose,
	onCompare,
	onVersions,
}: {
	wcId: string;
	path: string;
	revision: number;
	wholeCommit: boolean;
	onClose: () => void;
	onCompare?: () => void;
	onVersions: () => void;
}) {
	const { t } = useTranslation();
	const diff = useDiff(wcId, path, '', revision);
	const [stoppedKey, setStoppedKey] = useState('');
	const key = JSON.stringify(diff.queryKey);
	const stopped = stoppedKey === key;
	return (
		<div className="history-inline-diff" data-revision={revision}>
			<div className="history-diff-context">
				<span className="truncate" title={path}>
					r{revision - 1} → r{revision} · {path === '.' ? t('historyComparison.currentWorkingCopyScope') : path}
				</span>
				<Button variant="outline" size="sm" onClick={onVersions}>
					{t(wholeCommit ? 'fileVersions.rangeAction' : 'fileVersions.showVersions')}
				</Button>
				{diff.loading ? (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setStoppedKey(key);
							void diff.stop();
						}}
					>
						<Square />
						{t('historyComparison.stopLoading')}
					</Button>
				) : (
					(stopped || !!diff.error) && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => {
								setStoppedKey('');
								void diff.refetch();
							}}
						>
							<RefreshCw />
							{t('historyComparison.reload')}
						</Button>
					)
				)}
			</div>
			<DiffView
				text={diff.text}
				loading={diff.loading}
				unsupported={diff.unsupported}
				error={stopped ? t('historyComparison.diffLoadingStopped') : diff.error}
				revision={revision}
				title={wholeCommit ? t('historyComparison.commitDiff') : path}
				onClose={onClose}
				onCompare={onCompare}
			/>
		</div>
	);
}
