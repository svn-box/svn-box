import { QueryClient, infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { LogEntry, Operation, Snapshot } from '../../../shared/types';
import type { ClientCall } from '../lib/api-types';

export const queryKeys = {
	workingCopy: (wcId: string) => ['workingCopy', wcId] as const,
	status: (wcId: string, remote = false) => ['workingCopy', wcId, 'status', remote ? 'remote' : 'local'] as const,
	operations: ['operations'] as const,
};

export function mergeOperations(incoming: Operation[], existing: Operation[] = []): Operation[] {
	const entries = new Map(existing.map((operation) => [operation.id, operation]));
	for (const next of incoming) {
		const old = entries.get(next.id);
		if (
			!old ||
			(next.endedAt && !old.endedAt) ||
			(next.endedAt ?? next.startedAt) > (old.endedAt ?? old.startedAt) ||
			(!old.endedAt && next.logs.join('').length >= old.logs.join('').length)
		) {
			entries.set(next.id, next);
		}
	}
	return [...entries.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 100);
}

export function createSvnQueries(call: ClientCall, onSnapshot: (snapshot: Snapshot) => void = () => {}, onScanError: (wcId: string, error: unknown) => void = () => {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				networkMode: 'always',
				refetchOnMount: true,
				refetchOnWindowFocus: false,
				refetchOnReconnect: false,
				staleTime: Infinity,
				gcTime: 5 * 60_000,
			},
			mutations: { retry: false, networkMode: 'always' },
		},
	});
	const statusOptions = (wcId: string, remote = false) =>
		queryOptions({
			queryKey: queryKeys.status(wcId, remote),
			queryFn: async ({ signal }) => {
				const result = await call('status', { wcId, remote }, { signal }).catch((error) => {
					if (!signal.aborted && (error as { kind?: string })?.kind !== 'cancelled') {
						onScanError(wcId, error);
					}
					throw error;
				});
				if (!signal.aborted) {
					onSnapshot(result);
					if (remote) {
						client.setQueryData<Snapshot>(queryKeys.status(wcId), (old) =>
							old && old.scannedAt > result.scannedAt ? old : { ...result, remote: false, remoteRevision: undefined, remoteChanges: undefined },
						);
					}
				}
				const current = client.getQueryData<Snapshot>(queryKeys.status(wcId, remote));
				return current && current.scannedAt > result.scannedAt ? current : result;
			},
			meta: { wcId, kind: 'status' },
		});

	const diffOptions = (wcId: string, path: string, scan = '', revision?: number, connectionVersion = 0) =>
		queryOptions({
			queryKey: [
				...queryKeys.workingCopy(wcId),
				'diff',
				revision === undefined ? 'local' : 'history',
				path,
				revision ?? null,
				revision === undefined ? scan : '',
				revision === undefined ? 0 : connectionVersion,
			] as const,
			queryFn: ({ signal }) => call('diff', { wcId, path, revision }, { signal }),
			gcTime: revision === undefined ? 60_000 : 5 * 60_000,
			meta: { wcId, kind: 'diff' },
		});

	const infoOptions = (wcId: string, path: string, scan = '') =>
		queryOptions({
			queryKey: [...queryKeys.workingCopy(wcId), 'info', path, scan],
			queryFn: ({ signal }) => call('info', { wcId, path }, { signal }),
			meta: { wcId, kind: 'info' },
		});

	const propertyOptions = (wcId: string, path: string, scan = '') =>
		queryOptions({
			queryKey: [...queryKeys.workingCopy(wcId), 'properties', path, scan],
			queryFn: ({ signal }) => call('properties', { wcId, path }, { signal }),
			meta: { wcId, kind: 'properties' },
		});

	const historyOptions = (wcId: string, path: string, connectionVersion = 0) =>
		infiniteQueryOptions({
			queryKey: [...queryKeys.workingCopy(wcId), 'history', path, connectionVersion] as const,
			initialPageParam: undefined as number | undefined,
			queryFn: ({ pageParam, signal }) => call('log', { wcId, path, before: pageParam }, { signal }),
			getNextPageParam: (page: LogEntry[]) => (page.length < 50 || (page.at(-1)?.revision ?? 0) <= 1 ? undefined : page.at(-1)!.revision - 1),
			meta: { wcId, kind: 'history' },
		});

	const listOptions = (url: string, repositoryId?: string, connectionVersion = 0, useExistingAuthentication = false) =>
		queryOptions({
			queryKey: ['remote', repositoryId ?? '', url, connectionVersion] as const,
			queryFn: ({ signal }) => call('list', { url, repositoryId }, { signal, useExistingAuthentication }),
			meta: { kind: 'list' },
		});

	const operationOptions = () =>
		queryOptions({
			queryKey: queryKeys.operations,
			queryFn: async () => mergeOperations(await call('operations', undefined), client.getQueryData(queryKeys.operations)),
			structuralSharing: false,
		});
	return {
		client,
		statusOptions,
		diffOptions,
		infoOptions,
		propertyOptions,
		historyOptions,
		listOptions,
		operationOptions,
		async refreshStatus(wcId: string, remote = false) {
			const options = statusOptions(wcId, remote);
			await client.cancelQueries({ queryKey: options.queryKey, exact: true });
			return client.fetchQuery({ ...options, staleTime: 0 });
		},
		async verifyHistory(wcId: string) {
			const filter = { queryKey: [...queryKeys.workingCopy(wcId), 'history'] };
			await client.cancelQueries(filter);
			await client.invalidateQueries(filter);
		},
		async invalidateWorkingCopy(wcId: string, history: boolean) {
			const filter = { queryKey: queryKeys.workingCopy(wcId), predicate: (query: { meta?: Record<string, unknown> }) => history || query.meta?.kind !== 'history' };
			await client.cancelQueries(filter);
			await client.invalidateQueries({ ...filter, refetchType: 'none' });
			// Refresh the scan first: local previews use its timestamp as their cache generation.
			await client.fetchQuery({ ...statusOptions(wcId), staleTime: 0 }).catch(() => {});
			await client.refetchQueries({ ...filter, type: 'active', predicate: (query) => filter.predicate(query) && query.meta?.kind !== 'status' && query.state.isInvalidated });
		},
	};
}

export type SvnQueries = ReturnType<typeof createSvnQueries>;
