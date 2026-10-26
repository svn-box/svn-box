interface RefreshContext {
	wcId?: string;
	foreground: boolean;
	busy: boolean;
	scanning: boolean;
	refreshedAt: number;
}

export function createForegroundRefresh(read: () => RefreshContext, refresh: (wcId: string) => Promise<unknown>) {
	let pending: { wcId: string; at: number } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastStarted = -Infinity;
	let running = false;
	let disposed = false;

	function resume(): void {
		if (disposed || !pending || running || timer !== undefined) {
			return;
		}
		const context = read();
		if (context.wcId !== pending.wcId || context.refreshedAt >= pending.at) {
			pending = undefined;
			return;
		}
		if (!context.foreground || context.busy || context.scanning) {
			return;
		}
		const delay = Math.max(0, pending.at + 250 - Date.now(), lastStarted + 1500 - Date.now());
		timer = setTimeout(() => void run(), delay);
	}

	async function run(): Promise<void> {
		timer = undefined;
		if (disposed || !pending) {
			return;
		}
		const context = read();
		if (context.wcId !== pending.wcId || context.refreshedAt >= pending.at) {
			pending = undefined;
			return;
		}
		if (!context.foreground || context.busy || context.scanning) {
			return;
		}
		if (Date.now() < pending.at + 250 || Date.now() < lastStarted + 1500) {
			resume();
			return;
		}
		const wcId = pending.wcId;
		pending = undefined;
		running = true;
		lastStarted = Date.now();
		try {
			await refresh(wcId);
		} catch {
			// The status query exposes failures in the workspace; focus does not retry or toast.
		} finally {
			running = false;
			resume();
		}
	}

	return {
		request(): void {
			const context = read();
			if (disposed || !context.foreground || !context.wcId) {
				return;
			}
			pending = { wcId: context.wcId, at: Date.now() };
			resume();
		},

		resume,

		dispose(): void {
			disposed = true;
			pending = undefined;
			clearTimeout(timer);
		},
	};
}
