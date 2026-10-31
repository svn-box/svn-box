import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AppUpdateAction, AppUpdateState } from '../../../shared/app-updates';
import { translate } from '../../../shared/i18n';
import { api, errorText } from '../lib/api';
import { workspaceStore } from '../state/workspace';

const initial: AppUpdateState = { phase: 'idle', revision: -1, currentVersion: '' };

function hasOtherDialog() {
	return Boolean(document.querySelector('[role="dialog"]:not(.app-update-dialog), [role="alertdialog"]'));
}

export function useAppUpdate() {
	const [state, setState] = useState(initial);
	const [open, setOpen] = useState(false);
	const [blocked, setBlocked] = useState(false);
	const [error, setError] = useState('');
	const [installing, setInstalling] = useState(false);
	const current = useRef(initial);
	const installLock = useRef(false);
	const accept = useCallback((next: AppUpdateState) => {
		if (next.revision < current.current.revision) {
			return;
		}
		const previous = current.current;
		current.current = next;
		setState(next);
		if (next.phase === 'downloaded' && next.phase !== previous.phase) {
			setOpen(true);
		}
		if (next.phase === 'current' && previous.phase === 'checking') {
			setOpen(false);
			toast(translate('appUpdate.currentToast', { version: next.currentVersion }), {
				id: 'app-update-current',
				closeButton: false,
				duration: 3000,
				style: { width: 'max-content', maxWidth: '100%', minHeight: 0, padding: '10px 16px', left: 0, right: 0, marginInline: 'auto' },
			});
		}
	}, []);
	useEffect(() => {
		let active = true;
		const receive = (next: AppUpdateState) => {
			if (active) {
				accept(next);
			}
		};
		const unsubscribe = api.onAppUpdate(receive);
		void api
			.call('appUpdate', { action: 'status' })
			.then(receive)
			.catch(() => {});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [accept]);
	useEffect(() => {
		const update = () => setBlocked(hasOtherDialog());
		const observer = new MutationObserver(update);
		observer.observe(document.body, { childList: true });
		update();
		return () => observer.disconnect();
	}, []);

	async function run(action: AppUpdateAction) {
		setError('');
		try {
			accept(await api.call('appUpdate', { action }));
		} catch (error) {
			setError(errorText(error));
			setOpen(true);
		}
	}

	async function check() {
		setError('');
		setBlocked(hasOtherDialog());
		setOpen(true);
		if (current.current.phase !== 'downloaded') {
			await run('check');
		}
	}

	function activate() {
		setBlocked(hasOtherDialog());
		setOpen(true);
	}

	async function install() {
		if (installLock.current) {
			return;
		}
		installLock.current = true;
		setInstalling(true);
		setError('');
		try {
			await workspaceStore.getState().flushSessions();
			accept(await api.call('appUpdate', { action: 'install' }));
		} catch (error) {
			setError(errorText(error));
		} finally {
			installLock.current = false;
			setInstalling(false);
		}
	}

	async function cancel() {
		await run('cancel');
		if (current.current.phase === 'paused') {
			setOpen(false);
		}
	}

	return {
		state,
		open: open && !blocked,
		error,
		installing,
		activate,
		check,
		install,
		cancel,
		release: () => run('release'),
		close: () => {
			if (!installLock.current && current.current.phase !== 'installing') {
				setOpen(false);
			}
		},
	};
}
