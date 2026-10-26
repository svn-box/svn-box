import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AppUpdates } from '../src/main/app-updates';
import type { AppUpdateState } from '../src/shared/app-updates';
import { schemas } from '../src/shared/validation';

function fixture(disabledReason?: string) {
	const client = Object.assign(new EventEmitter(), {
		checkForUpdates: vi.fn(async () => {
			client.emit('checking-for-update');
			client.emit('update-available', { version: '0.2.0' });
			return null;
		}),
		downloadUpdate: vi.fn(async () => {
			client.emit('download-progress', { percent: 46 });
			client.emit('update-downloaded', { version: '0.2.0' });
			return [];
		}),
		quitAndInstall: vi.fn(),
	});
	const changes: AppUpdateState[] = [];
	const isBusy = vi.fn(() => false);
	const beforeInstall = vi.fn(async () => {});
	const updates = new AppUpdates({ client, version: '0.1.1', disabledReason, isBusy, beforeInstall, onChange: (state) => changes.push(state) });
	return { updates, client, changes, isBusy, beforeInstall };
}

describe('application updates', () => {
	it('checks once without downloading, downloads on request and flushes before restarting', async () => {
		const { updates, client, changes, beforeInstall } = fixture();
		await Promise.all([updates.act('check'), updates.act('check')]);
		expect(client.checkForUpdates).toHaveBeenCalledTimes(1);
		expect(client.downloadUpdate).not.toHaveBeenCalled();
		expect(updates.getState()).toMatchObject({ phase: 'available', currentVersion: '0.1.1', version: '0.2.0' });
		await Promise.all([updates.act('download'), updates.act('download')]);
		expect(client.downloadUpdate).toHaveBeenCalledTimes(1);
		expect(changes).toContainEqual(expect.objectContaining({ phase: 'downloading', percent: 46 }));
		expect(updates.getState().phase).toBe('downloaded');
		expect(client.quitAndInstall).not.toHaveBeenCalled();
		let finish!: () => void;
		beforeInstall.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const installing = updates.act('install');
		await vi.waitFor(() => expect(beforeInstall).toHaveBeenCalled());
		expect(client.quitAndInstall).not.toHaveBeenCalled();
		finish();
		await installing;
		expect(client.quitAndInstall).toHaveBeenCalledTimes(1);
		expect(updates.getState().phase).toBe('installing');
	});

	it('preserves the downloaded update and retries after SVN finishes or preparation fails', async () => {
		const { updates, client, isBusy, beforeInstall } = fixture();
		await updates.act('check');
		await updates.act('download');
		isBusy.mockReturnValue(true);
		expect(await updates.act('install')).toMatchObject({ phase: 'downloaded', message: expect.stringContaining('SVN 操作') });
		expect(beforeInstall).not.toHaveBeenCalled();
		isBusy.mockReturnValue(false);
		beforeInstall.mockRejectedValueOnce(new Error('disk full'));
		expect((await updates.act('install')).phase).toBe('downloaded');
		expect(client.quitAndInstall).not.toHaveBeenCalled();
		await updates.act('install');
		expect(client.quitAndInstall).toHaveBeenCalledTimes(1);
	});

	it('rechecks active operations after preparing restart', async () => {
		const { updates, client, isBusy, beforeInstall } = fixture();
		await updates.act('check');
		await updates.act('download');
		beforeInstall.mockImplementationOnce(async () => {
			isBusy.mockReturnValue(true);
		});
		expect((await updates.act('install')).phase).toBe('downloaded');
		expect(client.quitAndInstall).not.toHaveBeenCalled();
	});

	it('recovers from network, checksum and native installation errors without exposing raw details', async () => {
		const { updates, client } = fixture();
		client.checkForUpdates.mockRejectedValueOnce(new Error('private HTTP details'));
		expect(await updates.act('check')).toMatchObject({ phase: 'error', message: expect.not.stringContaining('private') });
		await updates.act('check');
		client.downloadUpdate.mockRejectedValueOnce(new Error('checksum mismatch'));
		expect((await updates.act('download')).phase).toBe('error');
		await updates.act('download');
		await updates.act('install');
		client.emit('error', new Error('code signature validation failed'));
		expect(updates.getState()).toMatchObject({ phase: 'downloaded', version: '0.2.0' });
	});

	it('handles current releases, rejects malformed versions and does not install before download', async () => {
		const { updates, client } = fixture();
		await updates.act('install');
		await updates.act('download');
		expect(client.quitAndInstall).not.toHaveBeenCalled();
		expect(client.downloadUpdate).not.toHaveBeenCalled();
		client.emit('update-not-available', { version: '0.1.1' });
		expect(updates.getState().phase).toBe('current');
		client.emit('update-available', { version: '../../unexpected' });
		expect(updates.getState().phase).toBe('error');
	});

	it('does not perform network or installation actions in development mode and validates IPC commands', async () => {
		const { updates, client } = fixture('开发模式');
		for (const action of ['status', 'check', 'download', 'install'] as const) {
			expect((await updates.act(action)).phase).toBe('disabled');
		}
		expect(client.checkForUpdates).not.toHaveBeenCalled();
		expect(client.downloadUpdate).not.toHaveBeenCalled();
		expect(client.quitAndInstall).not.toHaveBeenCalled();
		expect(schemas.appUpdate.safeParse({ action: 'download', url: 'https://example.com' }).success).toBe(false);
		expect(schemas.appUpdate.safeParse({ action: 'unexpected' }).success).toBe(false);
	});
});
