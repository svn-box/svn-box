import { useTranslation } from 'react-i18next';
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
	labels,
	emptyMessage,
}: {
	text: string;
	loading?: boolean;
	error?: string;
	title?: string;
	unsupported?: string;
	onCompare?: () => void;
	onClose?: () => void;
	revision?: number;
	labels?: { left: string; right: string };
	emptyMessage?: string;
}) {
	const { t } = useTranslation();
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
		<section className="diff-view" aria-label={t('diffView.diffPreview')}>
			<div className="diff-toolbar">
				<div className="truncate flex items-center gap-2">
					<FileDiff size={14} />
					<span className="truncate">{title || t('diffView.diffPreview')}</span>
				</div>
				<div className="flex items-center gap-1">
					{onCompare && (
						<Button variant="ghost" size="sm" onClick={onCompare} title={t('diffView.compareRevisionsInFilemerge')}>
							<ExternalLink />
							FileMerge
						</Button>
					)}

					<div className="segmented-control" role="group" aria-label={t('diffView.diffDisplayMode')}>
						<Button variant="ghost" size="sm" aria-pressed={!split} onClick={() => setSplit(false)}>
							<AlignLeft />
							{t('diffView.unified')}
						</Button>
						<Button variant="ghost" size="sm" aria-pressed={split} onClick={() => setSplit(true)}>
							<Columns2 />
							{t('diffView.sideBySide')}
						</Button>
					</div>
					{onClose && (
						<Button variant="ghost" size="icon" aria-label={t('diffView.collapseDiffPreview')} onClick={onClose}>
							<X />
						</Button>
					)}
				</div>
			</div>
			{loading || parsing ? (
				<div className="empty">
					<LoaderCircle className="spin" size={22} />
					<span>{t('diffView.loadingDiff')}</span>
				</div>
			) : error ? (
				<div className="empty error-text">{error}</div>
			) : !text ? (
				<div className="empty">
					<FileDiff size={30} />
					<strong>
						{unsupported
							? t('diffView.textPreviewUnavailable')
							: (emptyMessage ?? (revision === undefined ? t('diffView.selectAFileToReviewItsChanges') : t('diffView.noTextOrPropertyDifferencesToDisplayIn')))}
					</strong>
					<span>
						{unsupported ||
							(!emptyMessage &&
								(revision === undefined ? t('diffView.textAndSvnPropertyDiffsAppearHere') : t('diffView.directoryStructureChangesAppearInThisCommitS')))}
					</span>
				</div>
			) : (
				<>
					<div className="diff-caption">
						<div className={`diff-comparison-labels ${split ? 'split' : ''}`}>
							{unsupported ? (
								<span>{unsupported}</span>
							) : split ? (
								<>
									<span>{labels?.left ?? (revision === undefined ? t('diffView.baseOriginal') : `r${revision - 1}`)}</span>
									<span>{labels?.right ?? (revision === undefined ? t('diffView.workingCopyCurrent') : `r${revision}`)}</span>
								</>
							) : (
								<span>
									{labels
										? `− ${labels.left}　+ ${labels.right}`
										: revision === undefined
											? t('diffView.baseOriginalContentCurrentWorkingCopyContent')
											: `− r${revision - 1}　+ r${revision}`}
								</span>
							)}
							{truncated && <span>{t('diffView.previewLimitedToLines')}</span>}
						</div>
						<div className="diff-navigation">
							<span>
								{hunks.length
									? t('diffView.changeOf', {
											value: hunk < 0 ? '—' : hunk + 1,
											count: hunks.length,
										})
									: ''}
							</span>
							<Button
								variant="ghost"
								size="icon"
								title={t('diffView.previousChange')}
								aria-label={t('diffView.previousChange')}
								disabled={!hunks.length}
								onClick={() => jump(-1)}
							>
								<ArrowUp />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								title={t('diffView.nextChange')}
								aria-label={t('diffView.nextChange')}
								disabled={!hunks.length}
								onClick={() => jump(1)}
							>
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
