import { createStore } from 'zustand/vanilla';
import { emptySession, isChanged, isConflict, type AppState, type Operation, type Snapshot, type WorkspaceSession } from '../../../shared/types';
import type { ClientCall } from '../lib/api-types';

export type WorkspaceCatalog = Omit<AppState, 'sessions' | 'activeId'>;
export interface SessionCheckpoint {
	draft: number;
	selected: number;
}

interface WorkspaceStoreState {
	catalog?: WorkspaceCatalog;
	activeId?: string;
	sessions: Record<string, WorkspaceSession>;
	connectionVersion: number;
	sessionWrites: Record<string, { pending: number; error?: string }>;
	showOperations: boolean;
	showDetails: boolean;
	sidebarWidth: number;
	detailsWidth: number;
	listHeight: number;
	accept: (next: AppState, activate?: boolean) => void;
	activate: (id: string) => void;
	patchSession: (patch: Partial<WorkspaceSession>, wcId?: string) => void;
	flushSessions: (wcId?: string) => Promise<void>;
	checkpoint: (wcId: string) => SessionCheckpoint;
	acceptCommit: (next: AppState, operation: Operation, checkpoint?: SessionCheckpoint, acceptCatalog?: boolean) => void;
	acceptSnapshot: (snapshot: Snapshot) => void;
	acceptScanError: (wcId: string, message: string) => void;
	setPanel: (panel: 'showOperations' | 'showDetails', value: boolean | ((previous: boolean) => boolean)) => void;
	setSize: (pane: 'sidebarWidth' | 'detailsWidth' | 'listHeight', value: number | ((previous: number) => number)) => void;
}

export const blankSession = emptySession();

function connectionIdentity(catalog?: WorkspaceCatalog): string {
	return JSON.stringify([
		catalog?.settings.svnPath,
		catalog?.credentials,
		catalog?.repositories.map(({ id, rootUrl, credentialId }) => [id, rootUrl, credentialId]),
		catalog?.workingCopies.map(({ id, url }) => [id, url]),
	]);
}

export function createWorkspaceStore(call: ClientCall, onError: (error: unknown) => void) {
	const writes = new Map<string, Set<Promise<void>>>();
	const versions = new Map<string, SessionCheckpoint>();
	const latestWrites = new Map<string, number>();
	const successfulWrites = new Map<string, number>();
	return createStore<WorkspaceStoreState>()((set, get) => ({
		sessions: {},
		connectionVersion: 0,
		sessionWrites: {},
		showOperations: false,
		showDetails: true,
		sidebarWidth: 256,
		detailsWidth: 250,
		listHeight: 300,
		accept(next, activate = false) {
			const { sessions: incoming, activeId, ...catalog } = next;
			const previous = get();
			catalog.workingCopies = catalog.workingCopies.map((copy) => {
				const old = previous.catalog?.workingCopies.find((entry) => entry.id === copy.id);
				return old?.lastScan && (!copy.lastScan || old.lastScan > copy.lastScan)
					? { ...copy, lastScan: old.lastScan, changeCount: old.changeCount, conflicts: old.conflicts, error: old.error }
					: copy;
			});
			const ids = new Set(catalog.workingCopies.map((copy) => copy.id));
			const sessions = Object.fromEntries([...ids].map((id) => [id, previous.sessions[id] ?? incoming[id] ?? emptySession()]));
			// A metadata response must not replace drafts or a more recent project switch.
			set({
				catalog,
				sessions,
				activeId: activate || !previous.activeId || !ids.has(previous.activeId) ? activeId : previous.activeId,
				connectionVersion: previous.connectionVersion + (connectionIdentity(previous.catalog) === connectionIdentity(catalog) ? 0 : 1),
			});
		},

		activate(id) {
			set({ activeId: id });
			void call('activate', { wcId: id }).catch(onError);
		},

		patchSession(patch, wcId = get().activeId) {
			if (!wcId) {
				return;
			}
			if (patch.view && patch.view !== 'history') {
				patch = { ...patch, lastFileView: patch.view };
			}
			const checkpoint = versions.get(wcId) ?? { draft: 0, selected: 0 };
			versions.set(wcId, { draft: checkpoint.draft + ('draft' in patch ? 1 : 0), selected: checkpoint.selected + ('selected' in patch ? 1 : 0) });
			set((state) => ({
				sessions: { ...state.sessions, [wcId]: { ...(state.sessions[wcId] ?? emptySession()), ...patch } },
				sessionWrites: { ...state.sessionWrites, [wcId]: { pending: (state.sessionWrites[wcId]?.pending ?? 0) + 1 } },
			}));
			const version = (latestWrites.get(wcId) ?? 0) + 1;
			latestWrites.set(wcId, version);
			const saved = get().sessions[wcId];
			const pending = writes.get(wcId) ?? new Set<Promise<void>>();
			writes.set(wcId, pending);
			// Dispatch immediately so application shutdown can flush the main process's queue.
			const task = call('session', { wcId, patch: saved })
				.then(
					() => {
						successfulWrites.set(wcId, Math.max(successfulWrites.get(wcId) ?? 0, version));
						if (version === latestWrites.get(wcId)) {
							set((state) => ({ sessionWrites: { ...state.sessionWrites, [wcId]: { ...state.sessionWrites[wcId], error: undefined } } }));
						}
					},
					(error) => {
						if ((successfulWrites.get(wcId) ?? 0) > version) {
							return;
						}
						set((state) => ({
							sessionWrites: { ...state.sessionWrites, [wcId]: { ...state.sessionWrites[wcId], error: (error as Error)?.message ?? '会话保存失败' } },
						}));
						onError(error);
					},
				)
				.finally(() => {
					pending.delete(task);
					set((state) => ({
						sessionWrites: { ...state.sessionWrites, [wcId]: { ...state.sessionWrites[wcId], pending: Math.max(0, (state.sessionWrites[wcId]?.pending ?? 1) - 1) } },
					}));
				});
			pending.add(task);
		},

		async flushSessions(wcId) {
			const pending = () => (wcId ? [...(writes.get(wcId) ?? [])] : [...writes.values()].flatMap((tasks) => [...tasks]));
			while (pending().length) {
				await Promise.all(pending());
			}
			const failed = Object.entries(get().sessionWrites).find(([id, value]) => (!wcId || id === wcId) && value.error);
			if (failed) {
				throw new Error(failed[1].error);
			}
		},

		checkpoint(wcId) {
			return { ...(versions.get(wcId) ?? { draft: 0, selected: 0 }) };
		},

		acceptCommit(next, operation, captured, acceptCatalog = true) {
			if (acceptCatalog) {
				get().accept(next);
			}
			const id = operation.wcId;
			if (operation.state !== 'success' || operation.label !== '提交变更' || !id || !captured) {
				return;
			}
			const saved = next.sessions[id];
			const local = get().sessions[id];
			if (!local || !saved) {
				return;
			}
			const current = get().checkpoint(id);
			const draft = captured.draft === current.draft ? saved.draft : local.draft;
			const selected = captured.selected === current.selected ? saved.selected : local.selected;
			set((state) => ({ sessions: { ...state.sessions, [id]: { ...local, draft, selected } } }));
			if (draft !== saved.draft || selected !== saved.selected) {
				get().patchSession({ draft, selected }, id);
			}
		},

		acceptSnapshot(snapshot) {
			const state = get();
			const copy = state.catalog?.workingCopies.find((copy) => copy.id === snapshot.wcId);
			if (!copy || (copy.lastScan && copy.lastScan > snapshot.scannedAt)) {
				return;
			}
			set({
				catalog: {
					...state.catalog!,
					workingCopies: state.catalog!.workingCopies.map((entry) =>
						entry.id === copy.id
							? {
									...entry,
									lastScan: snapshot.scannedAt,
									changeCount: snapshot.files.filter(isChanged).length,
									conflicts: snapshot.files.filter(isConflict).length,
									error: undefined,
								}
							: entry,
					),
				},
			});
			const saved = get().sessions[copy.id] ?? emptySession();
			const valid = new Set(snapshot.files.filter(isChanged).map((file) => file.path));
			const selected = saved.selected.filter((path) => valid.has(path));
			const expanded = new Set(saved.expanded);
			if (!saved.treeInitialized) {
				for (const file of snapshot.files.filter((file) => isChanged(file) || file.item === 'unversioned')) {
					const parts = file.path.split('/').slice(0, -1);
					for (let depth = 1; depth <= parts.length; depth++) {
						expanded.add(parts.slice(0, depth).join('/'));
					}
				}
			}
			if (selected.length !== saved.selected.length || !saved.treeInitialized) {
				get().patchSession({ selected, expanded: [...expanded], treeInitialized: true }, copy.id);
			}
		},

		acceptScanError(wcId, message) {
			set((state) =>
				state.catalog
					? { catalog: { ...state.catalog, workingCopies: state.catalog.workingCopies.map((copy) => (copy.id === wcId ? { ...copy, error: message } : copy)) } }
					: {},
			);
		},

		setPanel(panel, value) {
			set({ [panel]: typeof value === 'function' ? value(get()[panel]) : value });
		},

		setSize(pane, value) {
			set({ [pane]: typeof value === 'function' ? value(get()[pane]) : value });
		},
	}));
}
