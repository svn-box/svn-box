import * as React from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { cn } from '../../lib/utils';
import { MenuItemContents, type MenuItemExtras } from './menu-item';
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuSeparator = Menu.Separator;
export const DropdownMenuGroup = Menu.Group;
export function DropdownMenuContent({ className, ...props }: React.ComponentProps<typeof Menu.Content>) {
	return (
		<Menu.Portal>
			<Menu.Content className={cn('dropdown-content', className)} sideOffset={5} {...props} />
		</Menu.Portal>
	);
}
export function DropdownMenuItem({ icon, shortcut, destructive, children, className, ...props }: React.ComponentProps<typeof Menu.Item> & MenuItemExtras) {
	return (
		<Menu.Item className={cn('dropdown-item', className)} data-destructive={destructive || undefined} {...props}>
			<MenuItemContents icon={icon} shortcut={shortcut}>
				{children}
			</MenuItemContents>
		</Menu.Item>
	);
}
