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
		let update = await window.svnbox.call('appUpdate', { action: 'status' });
		assert(update.phase === 'idle', 'An isolated updater fixture starts without automatic checks');
		assert(!document.querySelector('.app-update-button'), 'The titlebar has no permanent app update button');
		const updatePhases = new Set();
		const unsubscribeUpdates = window.svnbox.onAppUpdate((next) => {
			update = next;
			updatePhases.add(next.phase);
		});
		await invoke('smoke_menu', { action: 'app-update' });
		await waitFor(() => update.phase === 'checking' && button('取消检查'));
		assert(!document.querySelector('.app-update-button'), 'Checking from the menu keeps the update button hidden');
		await waitFor(
			() =>
				update.phase === 'current' &&
				!document.querySelector('[role="dialog"]') &&
				document.querySelector('[data-sonner-toast]')?.textContent.includes(`已是最新版本 v${update.currentVersion}`),
		);
		assert(!document.querySelector('.app-update-button'), 'An up-to-date result does not leave a titlebar button');
		const toaster = document.querySelector('[data-sonner-toaster]');
		assert(toaster.dataset.xPosition === 'center' && toaster.dataset.yPosition === 'top', 'All toasts are positioned at the top center');
		assert(!document.querySelector('.app-update-dialog'), 'An up-to-date result uses a compact version toast instead of an update dialog');
		const currentToast = document.querySelector('[data-sonner-toast]');
		await waitFor(() => Number(getComputedStyle(currentToast).opacity) >= 0.99);
		const toastBounds = currentToast.getBoundingClientRect();
		assert(
			Math.abs(toastBounds.x + toastBounds.width / 2 - innerWidth / 2) < 2 && toastBounds.top >= document.querySelector('.titlebar').getBoundingClientRect().bottom,
			'The compact toast is centered below the titlebar',
		);
		await invoke('smoke_snapshot', { name: 'update-current' });
		await waitFor(() => !document.querySelector('[data-sonner-toast]'));
		await invoke('smoke_menu', { action: 'app-update' });
		await waitFor(() => update.phase === 'error' && button('重新检查'));
		assert(update.messageKey === 'updates.checkFailed' && !update.version, 'A failed update check reports its cause without claiming a new version');
		assert(
			document.querySelector('.app-update-dialog [role="alert"]') && button('关闭') && !document.querySelector('.app-update-button'),
			'Check failures show Close and Check again without a titlebar button',
		);
		await Promise.all(
			document
				.querySelector('.app-update-dialog')
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished.catch(() => {})),
		);
		await invoke('smoke_snapshot', { name: 'update-error' });
		button('重新检查').click();
		await waitFor(() => update.phase === 'downloading');
		assert(!document.querySelector('.settings-dialog'), 'The native update menu starts a background check without opening settings');
		await waitFor(() => button('稍后'));
		button('稍后').click();
		await waitFor(() => !document.querySelector('[role="dialog"]'));
		await waitFor(() => update.phase === 'error' && document.querySelector('.app-update-button')?.textContent.trim() === '重试');
		assert(update.messageKey === 'updates.downloadFailed', 'Real signature verification rejects a modified update payload');
		assert(!document.querySelector('[role="dialog"]'), 'Background download failures preserve a retry entry without reopening a dismissed prompt');
		document.querySelector('.app-update-button').click();
		await waitFor(() => document.querySelector('.app-update-dialog [role="alert"]') && button('重新检查'));
		assert(document.querySelector('.app-update-dialog h2').textContent === '更新遇到问题', 'The retry entry opens the failure details in the update dialog');
		button('稍后').click();
		await waitFor(() => !document.querySelector('[role="dialog"]'));
		await invoke('smoke_menu', { action: 'app-update' });
		await waitFor(() => update.phase === 'downloading' && update.received > 65536);
		await waitFor(() => document.querySelector('.app-update-button [role="progressbar"]'));
		assert(!document.querySelector('.app-update-button [role="progressbar"]').hasAttribute('aria-valuenow'), 'Unknown download sizes show indeterminate progress');
		await waitFor(() => button('取消下载'));
		button('取消下载').click();
		await waitFor(() => update.phase === 'paused' && !document.querySelector('[role="dialog"]') && !document.querySelector('.app-update-button'));
		assert((await window.svnbox.call('appUpdate', { action: 'status' })).phase === 'paused', 'Cancellation stops the background transfer');
		await invoke('smoke_menu', { action: 'app-update' });
		await waitFor(() => update.phase === 'downloading' && update.percent > 0);
		await waitFor(() => Number(document.querySelector('.app-update-button [role="progressbar"]')?.getAttribute('aria-valuenow')) > 0);
		const ring = document.querySelector('.app-update-button [role="progressbar"]');
		assert(Number(ring.getAttribute('aria-valuenow')) > 0 && Number(ring.getAttribute('aria-valuenow')) < 100, 'The original update button shows real byte download progress');
		assert(document.querySelector('.app-update-button').textContent.trim() === '下载更新', 'An available update shows its download action instead of a permanent check button');
		await waitFor(() => button('稍后'));
		button('稍后').click();
		await waitFor(() => !document.querySelector('[role="dialog"]'));
		await invoke('smoke_snapshot', { name: 'update-progress' });
		const received = update.received;
		await invoke('smoke_menu', { action: 'settings' });
		await waitFor(() => button('通用设置'));
		assert(document.querySelectorAll('.settings-navigation button').length === 2, 'Settings only contains general and SVN tool preferences');
		await waitFor(() => update.received > received);
		assert(true, 'The background download continues while settings is open');
		await waitFor(() => update.phase === 'downloaded');
		assert(!document.querySelector('.app-update-dialog') && document.querySelector('.settings-dialog'), 'Ready prompts wait for the existing settings dialog to close');
		button('关闭').click();
		await waitFor(() => update.phase === 'downloaded' && button('重启以更新'));
		assert(updatePhases.has('verifying') && update.percent === 100, 'A signed retry reaches ready only after verification');
		assert(
			update.publishedAt === Date.parse('2026-10-29T08:00:00Z') && document.querySelector('.app-update-date')?.textContent.includes('2026年10月29日'),
			'The ready dialog shows the actual release date',
		);
		assert(
			document.querySelectorAll('.app-update-actions button').length === 2 && document.querySelector('.app-update-icon').naturalWidth > 0,
			'The ready dialog uses the app icon with Later and Restart actions',
		);
		assert(document.activeElement !== button('重启以更新'), 'The confirmation does not automatically focus installation');
		await Promise.all(
			document
				.querySelector('.app-update-dialog')
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished.catch(() => {})),
		);
		await invoke('smoke_snapshot', { name: 'update-ready' });
		button('稍后').click();
		await waitFor(() => !document.querySelector('[role="dialog"]'));
		assert((await window.svnbox.call('appUpdate', { action: 'check' })).phase === 'downloaded', 'Later retains the verified update without installation or another download');
		document.querySelector('.app-update-button').click();
		await waitFor(() => button('重启以更新'));
		button('稍后').click();
		await waitFor(() => !document.querySelector('[role="dialog"]'));
		unsubscribeUpdates();
		await invoke('smoke_menu', { action: 'settings' });
		await waitFor(() => button('通用设置'));
		assert(![...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent.trim() === '应用更新'), 'Settings has no application update controls');
		await waitFor(() => button('灰色'));
		const graphite = button('灰色');
		assert(graphite, 'All existing appearance themes remain available');
		graphite.click();
		await waitFor(() => document.documentElement.dataset.theme === 'dark');
		assert((await window.svnbox.call('state')).settings.theme === 'dark', 'Appearance changes persist through the Rust settings command');
		await invoke('smoke_snapshot', { name: 'settings' });
		button('关闭').click();
		await waitFor(() => !document.querySelector('[role="dialog"]'));
		document.querySelector('.app-update-button').click();
		await waitFor(() => button('重启以更新'));
		await Promise.all(
			document
				.querySelector('.app-update-dialog')
				.getAnimations({ subtree: true })
				.map((animation) => animation.finished.catch(() => {})),
		);
		await invoke('smoke_snapshot', { name: 'update-ready-dark' });
		button('稍后').click();
		await waitFor(() => !document.querySelector('[role="dialog"]'));
		await invoke('smoke_menu', { action: 'settings' });
		await waitFor(() => button('通用设置'));
		await window.svnbox.call('settings', { language: 'en' });
		await waitFor(() => document.documentElement.lang === 'en' && document.body.innerText.includes('Current version'));
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
