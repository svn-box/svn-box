import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function ScrollArea({ children, className, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Viewport>) {
	return (
		<ScrollAreaPrimitive.Root className="scroll-area" type="auto">
			<ScrollAreaPrimitive.Viewport className={cn('scroll-area-viewport', className)} {...props}>
				{children}
			</ScrollAreaPrimitive.Viewport>
			{(['vertical', 'horizontal'] as const).map((orientation) => (
				<ScrollAreaPrimitive.Scrollbar key={orientation} className="scroll-area-bar" orientation={orientation}>
					<ScrollAreaPrimitive.Thumb className="scroll-area-thumb" />
				</ScrollAreaPrimitive.Scrollbar>
			))}
			<ScrollAreaPrimitive.Corner className="scroll-area-corner" />
		</ScrollAreaPrimitive.Root>
	);
}
