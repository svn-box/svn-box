import type * as React from 'react';
import * as Menu from '@radix-ui/react-context-menu';
import { cn } from '../../lib/utils';
import { MenuItemContents, type MenuItemExtras } from './menu-item';

export const ContextMenu = Menu.Root;
export const ContextMenuSeparator = Menu.Separator;

export function ContextMenuTrigger({ onKeyDown, onContextMenu, disabled, ...props }: React.ComponentProps<typeof Menu.Trigger>) {
	return (
		<Menu.Trigger
			{...props}
			disabled={disabled}
			onContextMenu={(event) => {
				onContextMenu?.(event);
				if (!disabled && !event.defaultPrevented) {
					const target = event.target as HTMLElement;
					const focusable = target.closest<HTMLElement>('button, [tabindex]') ?? event.currentTarget.querySelector<HTMLElement>('button, [tabindex]');
					focusable?.focus({ preventScroll: true });
				}
			}}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				if (disabled || event.defaultPrevented || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				const bounds = event.currentTarget.getBoundingClientRect();
				event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: bounds.left + 20, clientY: bounds.bottom }));
			}}
		/>
	);
}

export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof Menu.Content>) {
	return (
		<Menu.Portal>
			<Menu.Content className={cn('dropdown-content context-menu-content', className)} {...props} />
		</Menu.Portal>
	);
}

export function ContextMenuItem({ icon, shortcut, destructive, children, className, ...props }: React.ComponentProps<typeof Menu.Item> & MenuItemExtras) {
	return (
		<Menu.Item className={cn('dropdown-item', className)} data-destructive={destructive || undefined} {...props}>
			<MenuItemContents icon={icon} shortcut={shortcut}>
				{children}
			</MenuItemContents>
		</Menu.Item>
	);
}
