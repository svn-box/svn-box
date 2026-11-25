export function selectAllInFocus() {
	const focus = document.activeElement;
	if (!(focus instanceof HTMLElement)) {
		return;
	}
	if (focus instanceof HTMLTextAreaElement || (focus instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(focus.type))) {
		focus.select();
		return;
	}
	const pane = focus.closest('[data-unversioned-list]');
	if (pane && (focus === pane || focus.closest('.file-table-header, .virtual-list'))) {
		const all = pane.querySelector<HTMLInputElement>('[data-select-all-files]');
		if (all && !all.checked && !all.disabled) {
			all.click();
		}
		return;
	}
	const selection = window.getSelection();
	if (!selection) {
		return;
	}
	// Static text can have a selection without taking keyboard focus.
	const anchor = selection.anchorNode;
	const target = focus === document.body ? (anchor instanceof Element ? anchor : anchor?.parentElement) : focus;
	if (!target) {
		return;
	}
	let content = target.closest('[contenteditable="true"], [contenteditable=""], .diff-scroll, .logs-output-viewport');
	if (!content && getComputedStyle(target).userSelect === 'text') {
		content = target;
		while (content.parentElement && getComputedStyle(content.parentElement).userSelect === 'text') {
			content = content.parentElement;
		}
	}
	if (content && !content.matches('input, button, select')) {
		selection.selectAllChildren(content);
	}
}
