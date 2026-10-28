import type { RpcMap, RpcName } from '../../../shared/types';

export function nativeInput(method: RpcName, input: unknown): unknown {
	if (method !== 'session') {
		return input ?? null;
	}
	const value = input as RpcMap['session']['input'];
	// JSON drops undefined properties; explicit null preserves an optional field reset.
	return { ...value, patch: Object.fromEntries(Object.entries(value.patch).map(([key, value]) => [key, value === undefined ? null : value])) };
}
