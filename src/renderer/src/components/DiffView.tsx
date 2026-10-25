import { useEffect, useRef, useState, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Columns2, AlignLeft, FileDiff, LoaderCircle, ExternalLink, X } from 'lucide-react';
import { Button } from './ui/button';
import type { DiffRow } from '../diff.worker';

export function DiffView({
	text,
	loading,
	error,
	title,
	unsupported,
	onCompare,
	onClose,
	revision,
}: {
	text: string;
	loading?: boolean;
	error?: string;
	title?: string;
	unsupported?: string;
	onCompare?: () => void;
	onClose?: () => void;
	revision?: number;
}) {
	const [split, setSplit] = useState(false);
	const [rows, setRows] = useState<DiffRow[]>([]);
	const [parsing, setParsing] = useState(false);
	const [truncated, setTruncated] = useState(false);
	const [hunk, setHunk] = useState(-1);
	const viewport = useRef<HTMLDivElement>(null);
	const worker = useRef<Worker | null>(null);
	const request = useRef(0);
	const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => viewport.current, estimateSize: () => 22, overscan: 15 });
	useEffect(() => {
		const instance = new Worker(new URL('../diff.worker.ts', import.meta.url), { type: 'module' });
		worker.current = instance;
		instance.onmessage = (event) => {
			if (event.data.id === request.current) {
				setRows(event.data.rows);
				setTruncated(event.data.truncated);
				setParsing(false);
				setHunk(-1);
				viewport.current?.scrollTo(0, 0);
			}
		};
		return () => instance.terminate();
	}, []);
	useEffect(() => {
		if (worker.current) {
			setParsing(true);
			worker.current.postMessage({ id: ++request.current, text, split });
		}
	}, [text, split]);
	const hunks = useMemo(() => rows.flatMap((row, index) => (row.type === 'hunk' ? [index] : [])), [rows]);
	function jump(direction: number) {
		if (!hunks.length) {
			return;
		}
		const next = Math.max(0, Math.min(hunks.length - 1, hunk + direction));
		setHunk(next);
		virtual.scrollToIndex(hunks[next], { align: 'start' });
	}
	return (
		<section className="diff-view" aria-label="差异预览">
			<div className="diff-toolbar">
				<div className="truncate flex items-center gap-2">
					<FileDiff size={14} />
					<span className="truncate">{title || '差异预览'}</span>
				</div>
				<div className="flex items-center gap-1">
					{onCompare && (
						<Button variant="ghost" size="sm" onClick={onCompare} title="用 FileMerge 比较两个版本">
							<ExternalLink />
							FileMerge
						</Button>
					)}

					<div className="segmented-control" role="group" aria-label="差异展示方式">
						<Button variant="ghost" size="sm" aria-pressed={!split} onClick={() => setSplit(false)}>
							<AlignLeft />
							统一
						</Button>
						<Button variant="ghost" size="sm" aria-pressed={split} onClick={() => setSplit(true)}>
							<Columns2 />
							并排
						</Button>
					</div>
					{onClose && (
						<Button variant="ghost" size="icon" aria-label="收起差异预览" onClick={onClose}>
							<X />
						</Button>
					)}
				</div>
			</div>
			{loading || parsing ? (
				<div className="empty">
					<LoaderCircle className="spin" size={22} />
					<span>正在读取差异</span>
				</div>
			) : error ? (
				<div className="empty error-text">{error}</div>
			) : !text ? (
				<div className="empty">
					<FileDiff size={30} />
					<strong>{revision === undefined ? '选择文件，审阅变更' : '此范围没有可显示的文本或属性差异'}</strong>
					<span>{unsupported || (revision === undefined ? '文本与 SVN 属性差异会显示在这里' : '目录结构变化可在本次提交的路径列表中查看')}</span>
				</div>
			) : (
				<>
					<div className="diff-caption">
						<div className={`diff-comparison-labels ${split ? 'split' : ''}`}>
							{unsupported ? (
								<span>{unsupported}</span>
							) : split ? (
								<>
									<span>{revision === undefined ? 'BASE · 原始版本' : `r${revision - 1}`}</span>
									<span>{revision === undefined ? '工作副本 · 当前内容' : `r${revision}`}</span>
								</>
							) : (
								<span>{revision === undefined ? '− BASE 原始内容　+ 工作副本当前内容' : `− r${revision - 1}　+ r${revision}`}</span>
							)}
							{truncated && <span>预览限制 120000 行</span>}
						</div>
						<div className="diff-navigation">
							<span>{hunks.length ? `${hunk < 0 ? '—' : hunk + 1} / ${hunks.length} 变更段` : ''}</span>
							<Button variant="ghost" size="icon" title="上一变更段" aria-label="上一变更段" disabled={!hunks.length} onClick={() => jump(-1)}>
								<ArrowUp />
							</Button>
							<Button variant="ghost" size="icon" title="下一变更段" aria-label="下一变更段" disabled={!hunks.length} onClick={() => jump(1)}>
								<ArrowDown />
							</Button>
						</div>
					</div>
					<div ref={viewport} className="diff-scroll">
						<div style={{ height: virtual.getTotalSize(), minWidth: '100%', position: 'relative' }}>
							{virtual.getVirtualItems().map((item) => {
								const row = rows[item.index];
								return (
									<div
										key={item.key}
										className={`diff-line ${row.type} ${split ? 'split' : ''}`}
										style={{ position: 'absolute', top: item.start, height: 22, width: '100%' }}
									>
										{split && !['hunk', 'meta'].includes(row.type) ? (
											<>
												<div className={row.type === 'pair' && row.oldLine !== undefined ? 'removed' : ''}>
													<span className="line-number">{row.oldLine}</span>
													<code>{row.old}</code>
												</div>
												<div className={['pair', 'add'].includes(row.type) && row.newLine !== undefined ? 'inserted' : ''}>
													<span className="line-number">{row.newLine}</span>
													<code>{row.next}</code>
												</div>
											</>
										) : (
											<>
												<span className="line-number">{row.oldLine}</span>
												<span className="line-number">{row.newLine}</span>
												<code>{row.next}</code>
											</>
										)}
									</div>
								);
							})}
						</div>
					</div>
				</>
			)}
		</section>
	);
}
