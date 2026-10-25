import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, CheckCircle2, CircleAlert, CircleX, LoaderCircle, TriangleAlert } from 'lucide-react';
import { type Operation } from '../../../shared/types';
import { operationHasConflicts, operationOutput } from '../lib/operation-log';
import { opLabels } from './file-presentation';
import { Button } from './ui/button';

export function OperationStatus({ operation }: { operation: Operation }) {
	const conflicts = operationHasConflicts(operation);
	const Icon =
		operation.state === 'running' || operation.state === 'waiting'
			? LoaderCircle
			: operation.state === 'success'
				? conflicts
					? TriangleAlert
					: CheckCircle2
				: operation.state === 'cancelled'
					? CircleX
					: CircleAlert;
	return (
		<span className={`logs-state ${conflicts ? 'uncertain' : operation.state}`}>
			<Icon size={12} className={operation.state === 'running' ? 'spin' : ''} />
			{conflicts ? '完成 · 有冲突' : opLabels[operation.state]}
		</span>
	);
}

export const OperationOutput = memo(function OperationOutput({ operation }: { operation: Operation }) {
	const [follow, setFollow] = useState(true);
	const viewport = useRef<HTMLDivElement>(null);
	const text = useMemo(() => operationOutput(operation), [operation]);
	const lines = useMemo(() => (text ? text.trimEnd().split('\n') : []), [text]);
	const virtualizer = useVirtualizer({ count: lines.length, getScrollElement: () => viewport.current, estimateSize: () => 19, overscan: 16 });

	useLayoutEffect(() => {
		if (follow && viewport.current) {
			viewport.current.scrollTop = viewport.current.scrollHeight;
		}
	}, [text, follow]);

	return (
		<div className="logs-output">
			<div className="logs-output-toolbar">
				<span>
					命令输出<span className="logs-line-count">{lines.length} 行</span>
				</span>
				<label>
					<input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
					自动跟随
				</label>
				<Button
					variant="ghost"
					size="icon"
					aria-label="跳到日志末尾"
					title="跳到末尾并跟随输出"
					onClick={() => {
						if (viewport.current) {
							viewport.current.scrollTop = viewport.current.scrollHeight;
						}
						setFollow(true);
					}}
				>
					<ArrowDownToLine size={13} />
				</Button>
			</div>
			<div
				ref={viewport}
				className="logs-output-viewport"
				tabIndex={0}
				aria-label="日志文本"
				onScroll={() => {
					const element = viewport.current;
					if (element && follow && element.scrollHeight - element.scrollTop - element.clientHeight > 38) {
						setFollow(false);
					}
				}}
			>
				{lines.length ? (
					<div className="logs-output-lines" style={{ height: virtualizer.getTotalSize() }}>
						{virtualizer.getVirtualItems().map((row) => (
							<div
								key={row.key}
								className={`logs-output-line ${/svn: [EW]\d+|^Error:/i.test(lines[row.index]) ? 'diagnostic' : ''}`}
								style={{ transform: `translateY(${row.start}px)` }}
							>
								<span aria-hidden="true">{row.index + 1}</span>
								<code>{lines[row.index] || ' '}</code>
							</div>
						))}
					</div>
				) : (
					<div className="logs-output-empty">
						{operation.state === 'waiting' ? '等待同一工作副本的前序操作完成…' : operation.state === 'running' ? '正在执行，等待命令输出…' : '此操作没有额外命令输出'}
					</div>
				)}
			</div>
		</div>
	);
});
