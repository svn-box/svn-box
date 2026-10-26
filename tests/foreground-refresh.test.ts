import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createForegroundRefresh } from '../src/renderer/src/queries/foreground-refresh';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
});

afterEach(() => vi.useRealTimers());

function fixture() {
	const context = { wcId: 'a' as string | undefined, foreground: true, busy: false, scanning: false, refreshedAt: 0 };
	const refresh = vi.fn(async (_wcId: string) => {
		context.refreshedAt = Date.now();
	});
	const controller = createForegroundRefresh(() => context, refresh);
	return { context, refresh, controller };
}

it('coalesces focus and visibility bursts, with no background polling', async () => {
	const { refresh, controller } = fixture();
	controller.request();
	await vi.advanceTimersByTimeAsync(200);
	controller.request();
	await vi.advanceTimersByTimeAsync(200);
	expect(refresh).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(50);
	expect(refresh).toHaveBeenCalledExactlyOnceWith('a');
	await vi.advanceTimersByTimeAsync(60_000);
	expect(refresh).toHaveBeenCalledTimes(1);
	controller.dispose();
});

it('defers while writing, and reuses a completed operation scan when it is fresh enough', async () => {
	const { context, refresh, controller } = fixture();
	context.busy = true;
	controller.request();
	await vi.advanceTimersByTimeAsync(3000);
	expect(refresh).not.toHaveBeenCalled();
	context.busy = false;
	context.scanning = true;
	controller.resume();
	await vi.advanceTimersByTimeAsync(3000);
	expect(refresh).not.toHaveBeenCalled();
	context.scanning = false;
	context.refreshedAt = Date.now();
	controller.resume();
	await vi.runAllTimersAsync();
	expect(refresh).not.toHaveBeenCalled();
	controller.dispose();
});

it('runs one deferred refresh after a write or failed scan without retrying indefinitely', async () => {
	const { context, refresh, controller } = fixture();
	refresh.mockRejectedValue(new Error('path unavailable'));
	context.busy = true;
	controller.request();
	await vi.advanceTimersByTimeAsync(500);
	context.busy = false;
	controller.resume();
	await vi.runAllTimersAsync();
	expect(refresh).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(30_000);
	expect(refresh).toHaveBeenCalledTimes(1);
	controller.dispose();
});

it('does not refresh a hidden view, a remote bookmark, or the project left before the debounce', async () => {
	const { context, refresh, controller } = fixture();
	context.foreground = false;
	controller.request();
	context.foreground = true;
	context.wcId = undefined;
	controller.request();
	context.wcId = 'a';
	controller.request();
	context.wcId = 'b';
	controller.resume();
	await vi.runAllTimersAsync();
	expect(refresh).not.toHaveBeenCalled();
	controller.request();
	await vi.runAllTimersAsync();
	expect(refresh).toHaveBeenCalledExactlyOnceWith('b');
	controller.dispose();
});

it('keeps the next focus request when another project scan finishes late, without overlapping scans', async () => {
	const { context, refresh, controller } = fixture();
	let finish!: () => void;
	refresh.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
	controller.request();
	await vi.advanceTimersByTimeAsync(250);
	context.wcId = 'b';
	controller.request();
	await vi.advanceTimersByTimeAsync(3000);
	expect(refresh).toHaveBeenCalledExactlyOnceWith('a');
	finish();
	await vi.runAllTimersAsync();
	expect(refresh.mock.calls).toEqual([['a'], ['b']]);
	controller.dispose();
});

it('delays rapid subsequent focus scans and cancels pending work on disposal', async () => {
	const { refresh, controller } = fixture();
	controller.request();
	await vi.advanceTimersByTimeAsync(250);
	await vi.advanceTimersByTimeAsync(100);
	controller.request();
	await vi.advanceTimersByTimeAsync(1200);
	expect(refresh).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(200);
	expect(refresh).toHaveBeenCalledTimes(2);
	controller.request();
	controller.dispose();
	await vi.runAllTimersAsync();
	expect(refresh).toHaveBeenCalledTimes(2);
});
