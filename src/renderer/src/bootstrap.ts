import { installDesktop } from './desktop/api';
import { invoke } from '@tauri-apps/api/core';

async function start(): Promise<void> {
	await installDesktop();
	await import('./main');
	await invoke('desktop_ready');
}

void start().catch((error: unknown) => {
	const root = document.getElementById('root');
	if (root) {
		root.textContent = error instanceof Error ? error.message : String(error);
	}
});
