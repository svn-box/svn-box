import { useEffect, useRef } from 'react';
import { isOperationActive, type Operation } from '../../../shared/types';
import { workspaceStore } from '../state/workspace';
import { createForegroundRefresh } from './foreground-refresh';
import { svnQueries } from './runtime';
import { queryKeys } from './svn-queries';

export function useForegroundRefresh(wcId?: string): void {
	const activeId = useRef(wcId);
	activeId.current = wcId;
	const controller = useRef<ReturnType<typeof createForegroundRefresh> | undefined>(undefined);
	useEffect(() => {
		const { client } = svnQueries;
		const refresh = createForegroundRefresh(
			() => {
				const id = activeId.current;
				const operations = client.getQueryData<Operation[]>(queryKeys.operations) ?? [];
				return {
					wcId: id,
					foreground: document.visibilityState === 'visible' && document.hasFocus(),
					busy:
						!!id && (!!workspaceStore.getState().updateIntents[id]?.preparing || operations.some((operation) => operation.wcId === id && isOperationActive(operation))),
					scanning: !!id && client.isFetching({ queryKey: queryKeys.workingCopy(id), predicate: (query) => query.meta?.kind === 'status' }) > 0,
					refreshedAt: id ? (client.getQueryState(queryKeys.status(id))?.dataUpdatedAt ?? 0) : 0,
				};
			},
			// Reuse an in-flight local scan instead of cancelling it like an explicit refresh.
			(id) => client.fetchQuery({ ...svnQueries.statusOptions(id), staleTime: 0 }),
		);
		controller.current = refresh;
		window.addEventListener('focus', refresh.request);
		document.addEventListener('visibilitychange', refresh.request);
		const unsubscribeQueries = client.getQueryCache().subscribe(refresh.resume);
		const unsubscribeWorkspace = workspaceStore.subscribe(refresh.resume);
		return () => {
			refresh.dispose();
			controller.current = undefined;
			window.removeEventListener('focus', refresh.request);
			document.removeEventListener('visibilitychange', refresh.request);
			unsubscribeQueries();
			unsubscribeWorkspace();
		};
	}, []);
	useEffect(() => controller.current?.resume(), [wcId]);
}
