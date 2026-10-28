import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { AppError, Operation, RpcMap, RpcName, SvnboxApi } from '../../../shared/types';
import type { UiLanguage } from '../../../shared/i18n';
import type { AppUpdateState } from '../../../shared/app-updates';
import { requestOptionsSchema, schemas } from '../../../shared/validation';
import { toast } from 'sonner';
import { nativeInput } from './transport';

export async function installDesktop(): Promise<void> {
	if (window.svnbox) {
		return;
	}
	if (!isTauri()) {
		throw new Error('请通过 npm run dev 启动仓盒桌面应用。');
	}
	const operations = new Set<(operation: Operation) => void>();
	const navigation = new Set<(action: string) => void>();
	const languages = new Set<(language: UiLanguage) => void>();
	const updates = new Set<(state: AppUpdateState) => void>();
	const subscriptions = await Promise.all([
		listen<Operation>('svnbox:operation', ({ payload }) => operations.forEach((callback) => callback(payload))),
		listen<string>('svnbox:navigate', ({ payload }) => navigation.forEach((callback) => callback(payload))),
		listen<UiLanguage>('svnbox:language', ({ payload }) => languages.forEach((callback) => callback(payload))),
		listen<AppUpdateState>('svnbox:app-update', ({ payload }) => updates.forEach((callback) => callback(payload))),
		listen('svnbox:closing', () => {
			void import('../state/workspace')
				.then(({ workspaceStore }) => workspaceStore.getState().flushSessions())
				.then(() => invoke('confirm_close'))
				.catch((error: unknown) => {
					void invoke('abort_close');
					toast.error(error instanceof Error ? error.message : String(error));
				});
		}),
	]);
	window.addEventListener('beforeunload', () => subscriptions.forEach((unsubscribe) => unsubscribe()), { once: true });

	function subscribe<T>(listeners: Set<T>, callback: T): () => void {
		listeners.add(callback);
		return () => listeners.delete(callback);
	}

	const api: SvnboxApi = {
		async call<K extends RpcName>(method: K, input: RpcMap[K]['input'], options = {}): Promise<RpcMap[K]['output']> {
			const data = schemas[method].parse(input);
			const request = requestOptionsSchema.parse(options);
			try {
				return await invoke<RpcMap[K]['output']>('svnbox_call', { method, input: nativeInput(method, data), options: request });
			} catch (error) {
				throw typeof error === 'object' && error && 'kind' in error ? error : ({ kind: 'command', message: String(error) } satisfies AppError);
			}
		},

		onOperation: (callback) => subscribe(operations, callback),
		onNavigate: (callback) => subscribe(navigation, callback),
		onLanguage: (callback) => subscribe(languages, callback),
		onAppUpdate: (callback) => subscribe(updates, callback),
	};
	window.svnbox = api;
	document.addEventListener('mousedown', (event) => {
		if (event.button !== 0 || event.detail > 1 || !(event.target instanceof Element)) {
			return;
		}
		if (event.target.closest('.titlebar') && !event.target.closest('button, input, select, a, [role="button"], [role="tab"], [role="separator"]')) {
			void getCurrentWindow().startDragging();
		}
	});
	document.addEventListener('dblclick', (event) => {
		if (event.target instanceof Element && event.target.closest('.titlebar') && !event.target.closest('button, input, select, a, [role="tab"]')) {
			void getCurrentWindow().toggleMaximize();
		}
	});
}
