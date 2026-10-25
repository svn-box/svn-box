import type { ReactNode } from 'react';

export interface MenuItemExtras {
	icon?: ReactNode;
	shortcut?: string;
	destructive?: boolean;
}

export function MenuItemContents({ icon, shortcut, children }: MenuItemExtras & { children?: ReactNode }) {
	return (
		<>
			<span className="menu-item-icon" aria-hidden="true">
				{icon}
			</span>
			<span className="menu-item-label">{children}</span>
			{shortcut && <kbd className="menu-item-shortcut">{shortcut}</kbd>}
		</>
	);
}
