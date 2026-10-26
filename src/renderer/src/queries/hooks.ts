import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Operation } from '../../../shared/types';
import { useWorkspaceStore } from '../state/workspace';
import { errorText } from '../lib/api';
import { svnQueries } from './runtime';

export function useStatus(wcId?: string, enabled = true) {
	return useQuery({ ...svnQueries.statusOptions(wcId ?? ''), enabled: !!wcId && enabled });
}

export function useHistory(wcId: string | undefined, path: string, enabled = true) {
	const version = useWorkspaceStore((state) => state.connectionVersion);
	return useInfiniteQuery({ ...svnQueries.historyOptions(wcId ?? '', path, version), enabled: !!wcId && enabled });
}

export function useHistoryEntries(wcId: string, path: string, search = '', enabled = true) {
	const history = useHistory(wcId, path, enabled);
	const logs = useMemo(() => history.data?.pages.flat(), [history.data]);
	const filteredLogs = useMemo(
		() =>
			(logs ?? []).filter(
				(entry) =>
					!search || `${entry.revision} ${entry.author} ${entry.message} ${entry.paths.map((item) => item.path).join(' ')}`.toLowerCase().includes(search.toLowerCase()),
			),
		[logs, search],
	);
	return { history, logs, filteredLogs };
}

export function useDiff(wcId: string | undefined, path: string, scan = '', revision?: number, enabled = true) {
	const version = useWorkspaceStore((state) => state.connectionVersion);
	const options = svnQueries.diffOptions(wcId ?? '', path, scan, revision, version);
	const query = useQuery({ ...options, enabled: !!wcId && !!path && enabled });
	return {
		text: enabled ? (query.data?.text ?? '') : '',
		unsupported: enabled ? (query.data?.unsupported ?? '') : '',
		loading: enabled && !!wcId && !!path && query.isFetching,
		error: enabled && query.error ? errorText(query.error) : '',
		queryKey: options.queryKey,
		refetch: query.refetch,
		stop: () => svnQueries.client.cancelQueries({ queryKey: options.queryKey, exact: true }),
	};
}

export function useFileInfo(wcId: string | undefined, path: string, scan = '', enabled = true) {
	const active = !!wcId && !!path && enabled;
	const info = useQuery({ ...svnQueries.infoOptions(wcId ?? '', path, scan), enabled: active });
	const properties = useQuery({ ...svnQueries.propertyOptions(wcId ?? '', path, scan), enabled: active });
	return {
		info: active ? info.data : undefined,
		properties: active ? properties.data : undefined,
		loading: active && (info.isFetching || properties.isFetching),
		error: active && (info.error || properties.error) ? errorText(info.error ?? properties.error) : '',
	};
}

export function useOperations() {
	return useQuery(svnQueries.operationOptions()).data ?? [];
}

export type OperationSummary = Pick<Operation, 'id' | 'wcId' | 'state' | 'label' | 'action'>;
const summarizeOperations = (operations: Operation[]): OperationSummary[] => operations.map(({ id, wcId, state, label, action }) => ({ id, wcId, state, label, action }));

export function useOperationSummary() {
	return useQuery({ ...svnQueries.operationOptions(), select: summarizeOperations, structuralSharing: true }).data ?? [];
}
