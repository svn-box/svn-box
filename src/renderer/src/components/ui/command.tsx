import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
	return <CommandPrimitive data-slot="command" className={cn('command', className)} {...props} />;
}

export function CommandInput(props: React.ComponentProps<typeof CommandPrimitive.Input>) {
	return (
		<div className="command-input-wrap">
			<Search size={14} />
			<CommandPrimitive.Input data-slot="command-input" {...props} />
		</div>
	);
}

export function CommandList(props: React.ComponentProps<typeof CommandPrimitive.List>) {
	return <CommandPrimitive.List className="command-list" {...props} />;
}

export function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
	return <CommandPrimitive.Empty className="command-empty" {...props} />;
}

export function CommandGroup(props: React.ComponentProps<typeof CommandPrimitive.Group>) {
	return <CommandPrimitive.Group className="command-group" {...props} />;
}

export function CommandItem(props: React.ComponentProps<typeof CommandPrimitive.Item>) {
	return <CommandPrimitive.Item className="command-item" {...props} />;
}
