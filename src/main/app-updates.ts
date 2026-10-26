import { translate } from '../shared/i18n';
import type { AppUpdater } from 'electron-updater';
import type { AppUpdateAction, AppUpdateState, AppUpdateMessageKey } from '../shared/app-updates';

class UpdateBusyError extends Error {
	constructor() {
		super(translate('updates.busy'));
	}
}
type UpdateClient = Pick<AppUpdater, 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'> & {
	on(event: 'checking-for-update' | 'update-not-available' | 'update-downloaded' | 'error', listener: () => void): unknown;
	on(event: 'update-available', listener: (info: { version: string }) => void): unknown;
	on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
};
export class AppUpdates {
	private state: AppUpdateState;
	private pending?: Promise<AppUpdateState>;
	private options: {
		client: UpdateClient;
		version: string;
		disabledReason?: string;
		disabledReasonKey?: AppUpdateMessageKey;
		isBusy: () => boolean;
		beforeInstall: () => Promise<void>;
		onChange: (state: AppUpdateState) => void;
	};

	constructor(options: AppUpdates['options']) {
		this.options = options;
		this.state = {
			phase: options.disabledReason ? 'disabled' : 'idle',
			currentVersion: options.version,
			revision: 0,
			message: options.disabledReason,
			messageKey: options.disabledReasonKey,
		};
		const client = options.client;
		client.on('checking-for-update', () => this.set({ phase: 'checking', version: undefined, percent: undefined, message: undefined }));
		client.on('update-not-available', () => this.set({ phase: 'current', version: undefined, message: undefined }));
		client.on('update-available', (info) => {
			if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(info.version)) {
				this.fail();
				return;
			}
			this.set({ phase: 'available', version: info.version, message: undefined });
		});
		client.on('download-progress', (progress) => {
			if (this.state.phase === 'downloading') {
				this.set({ percent: Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, progress.percent)) : 0 });
			}
		});
		client.on('update-downloaded', () => this.set({ phase: 'downloaded', percent: 100, message: undefined }));
		client.on('error', () => this.fail());
	}

	getState(): AppUpdateState {
		return {
			...this.state,
			message: this.state.messageKey ? translate(this.state.messageKey) : this.state.message,
		};
	}

	async act(action: Exclude<AppUpdateAction, 'release'>): Promise<AppUpdateState> {
		if (action === 'status' || this.options.disabledReason) {
			return this.getState();
		}
		if (this.pending) {
			return this.pending;
		}
		if (action === 'install') {
			if (this.state.phase !== 'downloaded') {
				return this.getState();
			}
			return this.run(async () => {
				this.checkIdle();
				this.set({ phase: 'installing', message: undefined });
				await this.options.beforeInstall();
				this.checkIdle();
				this.options.client.quitAndInstall();
			});
		}
		if (['downloaded', 'installing'].includes(this.state.phase)) {
			return this.getState();
		}
		if (action === 'download') {
			if (!this.state.version || !['available', 'error'].includes(this.state.phase)) {
				return this.getState();
			}
			return this.run(async () => {
				this.set({ phase: 'downloading', percent: 0, message: undefined });
				await this.options.client.downloadUpdate();
			});
		}
		return this.run(async () => {
			this.set({ phase: 'checking', version: undefined, percent: undefined, message: undefined });
			await this.options.client.checkForUpdates();
		});
	}

	private set(patch: Partial<AppUpdateState>): void {
		if (this.options.disabledReason) {
			return;
		}
		if (Object.hasOwn(patch, 'message') && !Object.hasOwn(patch, 'messageKey')) {
			patch = { ...patch, messageKey: undefined };
		}
		this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
		this.options.onChange(this.getState());
	}

	private checkIdle(): void {
		if (this.options.isBusy()) {
			throw new UpdateBusyError();
		}
	}

	private fail(messageKey?: AppUpdateMessageKey): void {
		const installing = this.state.phase === 'installing' || this.state.phase === 'downloaded';
		const key = messageKey ?? (installing ? 'updates.installFailed' : this.state.version ? 'updates.downloadFailed' : 'updates.checkFailed');
		this.set({
			phase: installing ? 'downloaded' : 'error',
			message: translate(key),
			messageKey: key,
		});
	}

	private run(work: () => Promise<void>): Promise<AppUpdateState> {
		// Defer the work so repeated actions share the lock even before the first await.
		this.pending = Promise.resolve()
			.then(work)
			.catch((error: unknown) => this.fail(error instanceof UpdateBusyError ? 'updates.busy' : undefined))
			.then(() => this.getState())
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}
}
