import { operationAction } from '../../../shared/operation-log';
import { translate } from '../../../shared/i18n';
import { api, errorText } from '../lib/api';
import { notifyError, notifyOperation } from '../lib/feedback';
import { workspaceStore } from '../state/workspace';
import type { AppState, Operation } from '../../../shared/types';
import type { SessionCheckpoint } from '../state/workspace-store';
import { createSvnQueries } from './svn-queries';
export const svnQueries = createSvnQueries(
	api.call,
	(snapshot) => workspaceStore.getState().acceptSnapshot(snapshot),
	(wcId, error) => workspaceStore.getState().acceptScanError(wcId, errorText(error)),
);
let workspaceRead = 0;
let appliedRead = 0;

export function acceptOperation(operation: Operation): Operation | undefined {
	const current = svnQueries.acceptOperation(operation);
	if (!current) {
		return;
	}
	const state = workspaceStore.getState();
	const project = state.catalog?.workingCopies.find((copy) => copy.id === current.wcId)?.name ?? translate('common.remoteRepository');
	const toastId = operationAction(current) === 'update' && current.wcId ? state.bindUpdateOperation(current.wcId, current.id) : undefined;
	notifyOperation(current, project, () => state.setPanel('showOperations', true), toastId);
	return current;
}

export async function readWorkspace(operation?: Operation, checkpoint?: SessionCheckpoint): Promise<void> {
	const request = ++workspaceRead;
	const next = await api.call('state', undefined);
	const latest = request >= appliedRead;
	if (latest) {
		appliedRead = request;
	}
	if (operation) {
		workspaceStore.getState().acceptCommit(next, operation, checkpoint, latest);
	} else if (latest) {
		workspaceStore.getState().accept(next);
	}
}

export function subscribeWorkspaceRuntime(onBootError: (error: unknown) => void = notifyError): () => void {
	const checkpoints = new Map<string, SessionCheckpoint>();
	void readWorkspace().catch(onBootError);

	const authenticationChanged = (event: Event) => workspaceStore.getState().accept((event as CustomEvent<AppState>).detail);

	window.addEventListener('svnbox:authentication-changed', authenticationChanged);
	const unsubscribe = api.onOperation((operation) => {
		const state = workspaceStore.getState();
		if (!acceptOperation(operation)) {
			return;
		}
		if (operation.wcId && !checkpoints.has(operation.id)) {
			checkpoints.set(operation.id, state.checkpoint(operation.wcId));
		}
		if (['running', 'waiting'].includes(operation.state)) {
			return;
		}
		// execute() returns an enqueued task. Only a terminal event can refresh its result.
		if (operation.wcId) {
			void svnQueries.invalidateWorkingCopy(operation.wcId, operation.state === 'success');
		}
		if (operation.state === 'success') {
			void readWorkspace(operation, checkpoints.get(operation.id)).catch(notifyError);
			void svnQueries.client.invalidateQueries({ queryKey: ['remote'] });
		}
		checkpoints.delete(operation.id);
	});
	return () => {
		unsubscribe();
		window.removeEventListener('svnbox:authentication-changed', authenticationChanged);
	};
}
