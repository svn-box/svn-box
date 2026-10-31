import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppUpdateAction, AppUpdateState } from '../../../shared/app-updates';
import { api, errorText } from '../lib/api';
import { workspaceStore } from '../state/workspace';

const initial: AppUpdateState = { phase: 'idle', revision: -1, currentVersion: '' };

export function useAppUpdate() {
	const [state, setState] = useState(initial);
	const [open, setOpen] = useState(false);
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
		if (next.phase !== previous.phase && ['downloaded', 'error'].includes(next.phase)) {
			setOpen(true);
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

	async function run(action: AppUpdateAction) {
		setError('');
		try {
			accept(await api.call('appUpdate', { action }));
		} catch (error) {
			setError(errorText(error));
			setOpen(true);
		}
	}

	function check() {
		setOpen(false);
		return run('check');
	}

	function activate() {
		if (!error && ['idle', 'current', 'paused'].includes(current.current.phase)) {
			void check();
		} else {
			setOpen(true);
		}
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
		open,
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
