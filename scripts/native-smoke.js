(async () => {
	const invoke = window.__TAURI_INTERNALS__.invoke;
	const checks = [];

	function assert(value, message) {
		if (!value) {
			throw new Error(message);
		}
		checks.push(message);
	}

	async function waitFor(callback, timeout = 20000) {
		const started = Date.now();
		while (!callback()) {
			if (Date.now() - started > timeout) {
				throw new Error('Timed out waiting for native UI: ' + document.body.innerText.slice(0, 1500));
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	function button(label) {
		return [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === label || button.getAttribute('aria-label') === label);
	}

	try {
		await waitFor(() => window.svnbox && document.querySelector('.app-shell') && document.body.innerText.includes('Native SVNBox'));
		assert(!document.querySelector('.fatal'), 'React workspace renders in the native WebKit view');
		const state = await window.svnbox.call('state');
		assert(state.workingCopies.length === 1, 'Native workspace state reaches the renderer');
		const wcId = state.workingCopies[0].id;
		const detected = await window.svnbox.call('detect', {});
		assert(detected.ok && detected.version.startsWith('1.'), 'Rust detects the bundled SVN runtime');
		const snapshot = await window.svnbox.call('status', { wcId });
		assert(snapshot.files.filter((file) => file.item === 'modified').length === 2, 'Rust reads real SVN changes');
		const diff = await window.svnbox.call('diff', { wcId, path: 'README.md' });
		assert(diff.text.includes('+native edit'), 'Rust returns a real SVN diff');
		await invoke('smoke_snapshot', { name: 'workspace' });
		await waitFor(() => [...document.querySelectorAll('.project-actions button')].some((button) => button.textContent.includes('提交') && !button.disabled));
		[...document.querySelectorAll('.project-actions button')].find((button) => button.textContent.includes('提交')).click();
		await waitFor(() => document.querySelector('[role="dialog"] textarea'));
		assert(document.querySelector('[role="dialog"] .commit-file-list') !== null, 'Commit dialog preserves the compact file selection table');
		assert(document.querySelector('[role="dialog"] .diff-view') === null, 'Commit dialog leaves differences in the workspace');
		await invoke('smoke_snapshot', { name: 'commit' });
		const close = button('稍后继续');
		assert(close, 'Commit dialog offers a way to continue later');
		close.click();
		await waitFor(() => !document.querySelector('[role="dialog"]'));
		await invoke('smoke_menu', { action: 'app-update' });
		await waitFor(() => document.querySelector('[role="dialog"]') && document.body.innerText.includes('应用更新'));
		const update = await window.svnbox.call('appUpdate', { action: 'status' });
		assert(update.phase === 'disabled', 'Development builds disable update downloads');
		assert(document.body.innerText.includes('开发'), 'Update status is localized in settings');
		button('通用设置').click();
		await waitFor(() => button('灰色'));
		const graphite = button('灰色');
		assert(graphite, 'All existing appearance themes remain available');
		graphite.click();
		await waitFor(() => document.documentElement.dataset.theme === 'dark');
		assert((await window.svnbox.call('state')).settings.theme === 'dark', 'Appearance changes persist through the Rust settings command');
		await invoke('smoke_snapshot', { name: 'settings' });
		await window.svnbox.call('settings', { language: 'en' });
		await waitFor(() => document.documentElement.lang === 'en' && document.body.innerText.includes('App Updates'));
		assert(true, 'Native language events update the renderer without restarting');
		const events = new Map();
		const unsubscribe = window.svnbox.onOperation((operation) => events.set(operation.id, operation));
		const review = await window.svnbox.call('review', { wcId, action: 'commit', paths: ['README.md'], message: 'Native selective commit' });
		const operation = await window.svnbox.call('execute', { reviewId: review.id });
		await waitFor(() => events.has(operation.id) && !['waiting', 'running'].includes(events.get(operation.id).state));
		assert(events.get(operation.id).state === 'success', 'Native operation events report a completed SVN commit');
		unsubscribe();
		const after = await window.svnbox.call('status', { wcId });
		assert(
			after.files.some((file) => file.path === 'other.txt' && file.item === 'modified'),
			'Native selective commit preserves an unselected file',
		);
		await window.svnbox.call('session', { wcId, patch: { historyRevision: 2 } });
		await window.svnbox.call('session', { wcId, patch: { historyRevision: undefined } });
		assert((await window.svnbox.call('state')).sessions[wcId].historyRevision === undefined, 'Optional history resets survive the Tauri JSON transport');
		await window.svnbox.call('session', { wcId, patch: { draft: 'Tauri native draft' } });
		assert((await window.svnbox.call('state')).sessions[wcId].draft === 'Tauri native draft', 'Rust persists per-working-copy commit drafts');
		await invoke('smoke_report', { report: { success: true, checks } });
	} catch (error) {
		await invoke('smoke_snapshot', { name: 'failure' }).catch(() => {});
		await invoke('smoke_report', { report: { success: false, checks, error: `${error?.message || String(error)}\n${error?.stack || ''}` } });
	}
})();
