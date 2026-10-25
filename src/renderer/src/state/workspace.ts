import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../lib/api';
import { notifyError } from '../lib/feedback';
import { blankSession, createWorkspaceStore } from './workspace-store';
import type { WorkspaceSession } from '../../../shared/types';

export const workspaceStore = createWorkspaceStore(api.call, notifyError);

export function useWorkspaceStore<T>(selector: (state: ReturnType<typeof workspaceStore.getState>) => T): T {
	return useStore(workspaceStore, selector);
}

export function useSessionSlice<K extends keyof WorkspaceSession>(wcId: string, keys: K[]): Pick<WorkspaceSession, K> {
	return useWorkspaceStore(
		useShallow((state) => {
			const session = state.sessions[wcId] ?? blankSession;
			return Object.fromEntries(keys.map((key) => [key, session[key]])) as Pick<WorkspaceSession, K>;
		}),
	);
}

export function useWorkspaceSession(wcId?: string): WorkspaceSession {
	return useWorkspaceStore((state) => (wcId ? (state.sessions[wcId] ?? blankSession) : blankSession));
}
