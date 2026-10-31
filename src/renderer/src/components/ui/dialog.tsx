import { useTranslation } from 'react-i18next';
import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
	children,
	className,
	overlayClassName,
	showCloseButton = true,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { overlayClassName?: string; showCloseButton?: boolean }) {
	const { t } = useTranslation();
	return (
		<DialogPrimitive.Portal>
			<DialogPrimitive.Overlay className={cn('dialog-overlay', overlayClassName)} />
			<DialogPrimitive.Content className={cn('dialog-content', className)} {...props}>
				{children}
				{showCloseButton && (
					<DialogPrimitive.Close className="dialog-x" aria-label={t('common.close')}>
						<X size={16} />
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Content>
		</DialogPrimitive.Portal>
	);
}
