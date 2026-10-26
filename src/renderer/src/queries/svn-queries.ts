import { QueryClient, infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { isOperationActive, type LogEntry, type Operation, type Snapshot, type RevisionRange } from '../../../shared/types';
import type { ClientCall } from '../lib/api-types';

export const queryKeys = {
	workingCopy: (wcId: string) => ['workingCopy', wcId] as const,
	status: (wcId: string, remote = false) => ['workingCopy', wcId, 'status', remote ? 'remote' : 'local'] as const,
	operations: ['operations'] as const,
};

type OperationVersion = Pick<Operation, 'state' | 'sequence'>;

function operationRegresses(next: OperationVersion, old: OperationVersion): boolean {
	return (!isOperationActive(old) && isOperationActive(next)) || (old.state === 'running' && next.state === 'waiting');
}

function newerOperation(next: Operation, old?: Operation): Operation {
	if (!old) {
		return next;
	}
	if (operationRegresses(next, old)) {
		return old;
	}
	if (old.sequence !== undefined || next.sequence !== undefined) {
		return (next.sequence ?? -1) > (old.sequence ?? -1) ? next : old;
	}
	return (next.endedAt && !old.endedAt) ||
		(next.endedAt ?? next.startedAt) > (old.endedAt ?? old.startedAt) ||
		(!old.endedAt && next.logs.join('').length >= old.logs.join('').length)
		? next
		: old;
}

export function mergeOperations(incoming: Operation[], existing: Operation[] = []): Operation[] {
	const entries = new Map(existing.map((operation) => [operation.id, operation]));
	for (const next of incoming) {
		entries.set(next.id, newerOperation(next, entries.get(next.id)));
	}
	const ordered = [...entries.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	const completed = new Set(
		ordered
			.filter((operation) => !isOperationActive(operation))
			.slice(0, 100)
			.map((operation) => operation.id),
	);
	return ordered.filter((operation) => isOperationActive(operation) || completed.has(operation.id));
}

export function createSvnQueries(call: ClientCall, onSnapshot: (snapshot: Snapshot) => void = () => {}, onScanError: (wcId: string, error: unknown) => void = () => {}) {
	const clearedOperations = new Set<string>();
	const operationVersions = new Map<string, OperationVersion>();
	const retained = (operations: Operation[] = []) => operations.filter((operation) => !clearedOperations.has(operation.id));
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

	const rangeDiffOptions = (wcId: string, path: string, range: RevisionRange, scan = '') =>
		queryOptions({
			queryKey: [...queryKeys.workingCopy(wcId), 'rangeDiff', path, range, range.to === 'WORKING' ? scan : ''] as const,
			queryFn: ({ signal }) => call('rangeDiff', { wcId, path, ...range }, { signal }),
			staleTime: range.to === 'WORKING' ? 0 : Infinity,
			meta: { wcId, kind: 'rangeDiff' },
		});

	const backupOptions = (wcId: string, path: string) =>
		queryOptions({
			queryKey: [...queryKeys.workingCopy(wcId), 'backups', path] as const,
			queryFn: () => call('backups', { wcId, path }),
			staleTime: 0,
			meta: { wcId, kind: 'backups' },
		});

	const mergeOptions = (wcId: string, path: string, scan = '') =>
		queryOptions({
			queryKey: [...queryKeys.workingCopy(wcId), 'merge', path, scan] as const,
			queryFn: ({ signal }) => call('mergeState', { wcId, path }, { signal }),
			staleTime: 0,
			meta: { wcId, kind: 'merge' },
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
			queryFn: async () => mergeOperations(retained(await call('operations', undefined)), retained(client.getQueryData(queryKeys.operations))),
			structuralSharing: false,
		});
	return {
		client,
		statusOptions,
		diffOptions,
		rangeDiffOptions,
		backupOptions,
		mergeOptions,
		infoOptions,
		propertyOptions,
		historyOptions,
		listOptions,
		operationOptions,
		acceptOperation(operation: Operation): Operation | undefined {
			if (clearedOperations.has(operation.id)) {
				return;
			}
			const existing = retained(client.getQueryData(queryKeys.operations));
			const previous = existing.find((entry) => entry.id === operation.id);
			const known = operationVersions.get(operation.id);
			if (known && (operationRegresses(operation, known) || (known.sequence !== undefined && (operation.sequence ?? -1) <= known.sequence))) {
				return;
			}
			if (previous && (operationRegresses(operation, previous) || (previous.sequence !== undefined && (operation.sequence ?? -1) < previous.sequence))) {
				return;
			}
			operationVersions.set(operation.id, { state: operation.state, sequence: operation.sequence });
			client.setQueryData(queryKeys.operations, mergeOperations([operation], existing));
			// Queries may see a completion first; event handling and visible retention are independent.
			return operation;
		},
		async clearOperations(ids: string[]) {
			await client.cancelQueries({ queryKey: queryKeys.operations, exact: true });
			const result = await call('clearOperations', { ids });
			for (const id of result.removedIds) {
				clearedOperations.add(id);
			}
			client.setQueryData<Operation[]>(queryKeys.operations, (previous) => mergeOperations(retained(result.operations), retained(previous)));
			return result;
		},
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
