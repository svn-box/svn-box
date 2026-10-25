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
}: {
	wcId: string;
	path: string;
	revision: number;
	wholeCommit: boolean;
	onClose: () => void;
	onCompare?: () => void;
}) {
	const diff = useDiff(wcId, path, '', revision);
	const [stoppedKey, setStoppedKey] = useState('');
	const key = JSON.stringify(diff.queryKey);
	const stopped = stoppedKey === key;
	return (
		<div className="history-inline-diff" data-revision={revision}>
			<div className="history-diff-context">
				<span className="truncate" title={path}>
					r{revision - 1} → r{revision} · {path === '.' ? '当前工作副本范围' : path}
				</span>
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
						停止读取
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
							重新读取
						</Button>
					)
				)}
			</div>
			<DiffView
				text={diff.text}
				loading={diff.loading}
				unsupported={diff.unsupported}
				error={stopped ? '已停止读取差异' : diff.error}
				revision={revision}
				title={wholeCommit ? '本次提交差异' : path}
				onClose={onClose}
				onCompare={onCompare}
			/>
		</div>
	);
}
