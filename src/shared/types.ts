import type { Theme } from './themes';
export type { Theme } from './themes';
export type View = 'changes' | 'files' | 'history';
export type Filter = 'all' | 'modified' | 'added' | 'deleted' | 'unversioned' | 'ignored' | 'conflicted';
export interface Repository {
	id: string;
	name: string;
	rootUrl: string;
	uuid: string;
	credentialId?: string;
	groupId?: string;
	favorite: boolean;
}
export interface RemoteBookmark {
	id: string;
	repositoryId: string;
	name: string;
	url: string;
}

export interface WorkingCopy {
	id: string;
	name: string;
	path: string;
	repositoryId: string;
	url: string;
	depth: string;
	groupId?: string;
	favorite: boolean;
	lastScan?: string;
	changeCount?: number;
	conflicts?: number;
	error?: string;
}
export interface WorkspaceSession {
	draft: string;
	selected: string[];
	filter: Filter;
	fileSearch?: string;
	expanded: string[];
	currentPath: string;
	view: View;
	lastFileView?: 'changes' | 'files';
	treeInitialized?: boolean;
	historyDiffPath?: string;
	historyTarget: string;
	historyRevision?: number;
	historySearch?: string;
	historyCollapsedDates?: string[];
	historyCollapsedRevisions?: number[];
	historyPreviewOpen?: boolean;
}
export interface CredentialProfile {
	id: string;
	name: string;
	username: string;
	rootUrl?: string;
}
export interface AuthenticationContext {
	url: string;
	rootUrl: string;
	username: string;
	credentialId?: string;
	repositoryRoot?: string;
	retrySafe?: boolean;
	reason?: 'missing' | 'rejected';
}
export interface AppState {
	version: 1;
	repositories: Repository[];
	workingCopies: WorkingCopy[];
	bookmarks: RemoteBookmark[];
	groups: { id: string; name: string }[];
	sessions: Record<string, WorkspaceSession>;
	credentials: CredentialProfile[];
	recentMessages: string[];
	settings: { svnPath: string; theme: Theme; mergeTool: string };
	activeId?: string;
}
export interface FileStatus {
	path: string;
	item: string;
	props: string;
	revision: string;
	author: string;
	date: string;
	kind: string;
	copied: boolean;
	switched: boolean;
	treeConflicted: boolean;
	movedFrom?: string;
	movedTo?: string;
	external: boolean;
}
export interface Snapshot {
	wcId: string;
	files: FileStatus[];
	scannedAt: string;
	fingerprint: string;
	remote?: boolean;
	remoteRevision?: string;
	remoteChanges?: number;
}
export interface SvnInfo {
	path: string;
	rootPath: string;
	url: string;
	rootUrl: string;
	uuid: string;
	revision: string;
	depth: string;
	kind: string;
	conflicts: Record<string, unknown>[];
}
export interface LogEntry {
	revision: number;
	author: string;
	date: string;
	message: string;
	paths: { path: string; action: string; kind: string; copyFrom?: string }[];
}
export interface DiffResult {
	text: string;
	unsupported?: string;
}
export interface Property {
	name: string;
	value: string;
}
export interface RemoteEntry {
	name: string;
	kind: string;
	size: number;
	revision: string;
	author: string;
	date: string;
}
export type OperationState = 'waiting' | 'running' | 'success' | 'failed' | 'cancelled' | 'uncertain';
export interface Operation {
	id: string;
	wcId?: string;
	label: string;
	state: OperationState;
	sequence?: number;
	startedAt: string;
	endedAt?: string;
	logs: string[];
	error?: AppError;
}
export const isOperationActive = (operation: Pick<Operation, 'state'>): boolean => operation.state === 'waiting' || operation.state === 'running';
export interface AppError {
	kind: 'auth' | 'certificate' | 'locked' | 'path' | 'network' | 'conflict' | 'cancelled' | 'stale' | 'validation' | 'command' | 'outdated';
	message: string;
	detail?: string;
	auth?: AuthenticationContext;
}
export type Action = 'commit' | 'update' | 'add' | 'rename' | 'delete' | 'ignore' | 'revert' | 'resolve' | 'cleanup';
export interface Review {
	id: string;
	wcId: string;
	action: Action;
	paths: string[];
	requested: string[];
	reasons: string[];
	warning?: string;
	fingerprint: string;
	createdAt: string;
	destination?: string;
	message?: string;
}
export interface Detection {
	path: string;
	version: string;
	ok: boolean;
	error?: string;
}
export interface RpcMap {
	state: { input: undefined; output: AppState };
	detect: { input: { path?: string }; output: Detection };
	settings: { input: Partial<AppState['settings']>; output: AppState };
	pickFolder: { input: undefined; output: string | null };
	addWorkingCopy: { input: { path: string; name?: string }; output: AppState };
	addRepository: { input: { url: string; name?: string; credentialId?: string }; output: AppState };
	bookmark: { input: { repositoryId: string; url: string; name: string; id?: string; remove?: boolean; direction?: 'up' | 'down' }; output: AppState };
	compare: { input: { wcId: string; path: string; revision?: number }; output: void };
	manage: {
		input: {
			entity: 'workingCopy' | 'repository' | 'group';
			id?: string;
			name?: string;
			remove?: boolean;
			favorite?: boolean;
			groupId?: string;
			direction?: 'up' | 'down';
			credentialId?: string;
		};
		output: AppState;
	};
	session: { input: { wcId: string; patch: Partial<WorkspaceSession> }; output: WorkspaceSession };
	activate: { input: { wcId: string }; output: void };
	status: { input: { wcId: string; remote?: boolean }; output: Snapshot };
	info: { input: { wcId: string; path: string }; output: SvnInfo };
	properties: { input: { wcId: string; path: string }; output: Property[] };
	diff: { input: { wcId: string; path: string; revision?: number }; output: DiffResult };
	log: { input: { wcId: string; path?: string; before?: number }; output: LogEntry[] };
	list: { input: { url: string; repositoryId?: string }; output: RemoteEntry[] };
	checkout: { input: { url: string; destination: string; repositoryId?: string; depth: 'infinity' | 'immediates' | 'files' | 'empty' }; output: Operation };
	review: { input: { wcId: string; action: Action; paths: string[]; destination?: string; message?: string }; output: Review };
	execute: { input: { reviewId: string }; output: Operation };
	operations: { input: undefined; output: Operation[] };
	copyOperation: { input: { id: string }; output: void };
	clearOperations: { input: { ids: string[] }; output: { removedIds: string[]; operations: Operation[] } };
	cancel: { input: { id: string }; output: void };
	cancelRequest: { input: { id: string }; output: void };
	authentication: { input: { url?: string; repositoryId?: string; wcId?: string; reviewId?: string }; output: AuthenticationContext | null };
	credential: { input: { rootUrl: string; url?: string; name?: string; username: string; password: string; id?: string; remove?: boolean }; output: AppState };
	credentialForEdit: { input: { id: string; rootUrl: string; url: string }; output: { username: string; password: string } };
	system: { input: { wcId: string; path: string; action: 'reveal' | 'copy' | 'terminal' | 'merge' }; output: void };
}
export type RpcName = keyof RpcMap;
export interface RequestOptions {
	requestId?: string;
}

export const isCancellableRpc = (method: RpcName): boolean =>
	['list', 'addRepository', 'checkout', 'log', 'status', 'info', 'properties', 'diff', 'compare', 'detect'].includes(method);

export type Reply<T> = { ok: true; value: T } | { ok: false; error: AppError };
export interface SvnboxApi {
	call<K extends RpcName>(method: K, input: RpcMap[K]['input'], options?: RequestOptions): Promise<RpcMap[K]['output']>;
	onOperation(callback: (operation: Operation) => void): () => void;
	onNavigate(callback: (action: string) => void): () => void;
}
export const emptySession = (): WorkspaceSession => ({ draft: '', selected: [], filter: 'all', expanded: ['.'], currentPath: '', view: 'changes', historyTarget: '.' });

export const isChanged = (file: FileStatus): boolean =>
	!['normal', 'none', 'external', 'ignored', 'unversioned'].includes(file.item) || ['modified', 'conflicted'].includes(file.props) || file.treeConflicted || file.copied;

export const isConflict = (file: FileStatus): boolean => file.item === 'conflicted' || file.props === 'conflicted' || file.treeConflicted;
