import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;
export function DialogContent({ children, className, overlayClassName, ...props }: React.ComponentProps<typeof DialogPrimitive.Content> & { overlayClassName?: string }) {
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Overlay className={cn('dialog-overlay', overlayClassName)} />
			<DialogPrimitive.Content className={cn('dialog-content', className)} {...props}>
				{children}
				<DialogPrimitive.Close className="dialog-x" aria-label="关闭">
					<X size={16} />
				</DialogPrimitive.Close>
			</DialogPrimitive.Content>
		</DialogPrimitive.Portal>
	);
}
