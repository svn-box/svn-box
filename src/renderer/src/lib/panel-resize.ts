import type { PointerEvent as ReactPointerEvent } from 'react';
import { workspaceStore } from '../state/workspace';

export function resizePanel(event: ReactPointerEvent, kind: 'sidebar' | 'details' | 'list') {
	if (event.button !== 0) {
		return;
	}
	event.preventDefault();
	const start = kind === 'list' ? event.clientY : event.clientX;
	const { sidebarWidth, detailsWidth, diffHeight } = workspaceStore.getState();
	const container = event.currentTarget.parentElement;
	const diff = kind === 'list' ? container?.querySelector<HTMLElement>(':scope > .diff-view') : undefined;
	const list = kind === 'list' ? container?.querySelector<HTMLElement>(':scope > .file-pane') : undefined;
	const minimum = diff ? Number.parseFloat(getComputedStyle(diff).minHeight) : 150;
	const maximum =
		container && list
			? container.clientHeight -
				Number.parseFloat(getComputedStyle(list).minHeight) -
				(container.querySelector('.draft-bar')?.getBoundingClientRect().height ?? 0) -
				event.currentTarget.getBoundingClientRect().height
			: diffHeight;
	const width = kind === 'sidebar' ? sidebarWidth : kind === 'details' ? detailsWidth : (diff?.getBoundingClientRect().height ?? diffHeight);
	event.currentTarget.setPointerCapture(event.pointerId);
	const move = (next: PointerEvent) => {
		const delta = (kind === 'list' ? next.clientY : next.clientX) - start;
		if (kind === 'sidebar') {
			workspaceStore.getState().setSize('sidebarWidth', Math.min(380, Math.max(204, width + delta)));
		} else if (kind === 'details') {
			workspaceStore.getState().setSize('detailsWidth', Math.min(410, Math.max(220, width - delta)));
		} else {
			workspaceStore.getState().setSize('diffHeight', Math.max(minimum, Math.min(maximum, width - delta)));
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
