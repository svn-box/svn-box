import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';
const buttonVariants = cva(
	'button inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs font-medium disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-3.5 [&_svg]:shrink-0',
	{
		variants: {
			variant: { default: 'button-primary', outline: 'button-outline', ghost: 'button-ghost', destructive: 'button-danger' },
			size: { default: 'h-8 px-3', sm: 'h-7 px-2', icon: 'h-8 w-8' },
		},
		defaultVariants: { variant: 'default', size: 'default' },
	},
);
function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
	const Comp = asChild ? Slot : 'button';
	return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
export { Button, buttonVariants };
