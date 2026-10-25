import type { PointerEvent as ReactPointerEvent } from 'react';
import { workspaceStore } from '../state/workspace';

export function resizePanel(event: ReactPointerEvent, kind: 'sidebar' | 'details' | 'list') {
	if (event.button !== 0) {
		return;
	}
	const start = kind === 'list' ? event.clientY : event.clientX;
	const { sidebarWidth, detailsWidth, listHeight } = workspaceStore.getState();
	const width = kind === 'sidebar' ? sidebarWidth : kind === 'details' ? detailsWidth : listHeight;
	event.currentTarget.setPointerCapture(event.pointerId);
	const move = (next: PointerEvent) => {
		const delta = (kind === 'list' ? next.clientY : next.clientX) - start;
		if (kind === 'sidebar') {
			workspaceStore.getState().setSize('sidebarWidth', Math.min(380, Math.max(204, width + delta)));
		} else if (kind === 'details') {
			workspaceStore.getState().setSize('detailsWidth', Math.min(410, Math.max(220, width - delta)));
		} else {
			workspaceStore.getState().setSize('listHeight', Math.min(650, Math.max(150, width + delta)));
		}
	};
	const stop = () => {
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', stop);
		window.removeEventListener('pointercancel', stop);
	};
	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', stop);
	window.addEventListener('pointercancel', stop);
}
