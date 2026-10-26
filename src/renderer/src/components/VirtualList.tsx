import { useRef, useEffect, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ScrollArea } from './ui/scroll-area';
export function VirtualList<T>({
	items,
	height = 36,
	render,
	label,
	activeIndex,
	minWidth,
}: {
	items: T[];
	height?: number;
	render: (item: T, index: number) => ReactNode;
	label: string;
	activeIndex?: number;
	minWidth?: number;
}) {
	const parent = useRef<HTMLDivElement>(null);
	const virtual = useVirtualizer({ count: items.length, getScrollElement: () => parent.current, estimateSize: () => height, overscan: 12 });
	useEffect(() => {
		virtual.measure();
	}, [height, virtual]);

	useEffect(() => {
		if (activeIndex !== undefined && activeIndex >= 0) {
			virtual.scrollToIndex(activeIndex, { align: 'auto' });
		}
	}, [activeIndex, items.length, height]);
	return (
		<ScrollArea ref={parent} className="virtual-list" role="list" aria-label={label}>
			<div style={{ height: virtual.getTotalSize(), position: 'relative', minWidth }}>
				{virtual.getVirtualItems().map((row) => (
					<div key={row.key} role="listitem" data-parity={row.index % 2 ? 'odd' : 'even'} style={{ position: 'absolute', top: row.start, height, width: '100%' }}>
						{render(items[row.index], row.index)}
					</div>
				))}
			</div>
		</ScrollArea>
	);
}
