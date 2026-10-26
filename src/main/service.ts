import { operationLabel } from '../shared/operation-log';
import { translate, uiI18n, UI_LANGUAGE } from '../shared/i18n';
import { appendOperationLog } from './operation-logs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, realpath, readFile, readdir, writeFile, rename, readlink, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { Store } from './store';
import { svnAddress, credentialRoot, connectionRoot, withinCredentialRoot, findCredential } from '../shared/auth';
import { Runner, SvnError, classify, redact } from './runner';
import {
	emptySession,
	isCancellableRpc,
	isChanged,
	isConflict,
	isOperationActive,
	type AppState,
	type FileStatus,
	type Snapshot,
	type SvnInfo,
	type Repository,
	type WorkingCopy,
	type Operation,
	type Review,
	type LogEntry,
	type Property,
	type RemoteEntry,
	type RpcMap,
} from '../shared/types';
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false, trimValues: false, processEntities: true });

const arr = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

const str = (value: unknown): string => (typeof value === 'object' && value !== null ? String((value as Record<string, unknown>)['#text'] ?? '') : String(value ?? ''));

const fail = (message: string, kind: 'validation' | 'stale' | 'path' = 'validation'): never => {
	throw new SvnError({ kind, message });
};

const peg = (path: string): string => `${path}@`;

const contains = (parent: string, path: string): boolean => parent === '.' || path === parent || path.startsWith(`${parent}/`);

const normalized = (path: string): string => path.split(sep).join('/') || '.';

export interface Vault {
	get(id: string): Promise<string | undefined>;
	set(id: string, password: string): Promise<void>;
	delete(id: string): Promise<void>;
}
export class SvnService {
	readonly store: Store;
	readonly runner: Runner;
	private vault?: Vault;
	private queues = new Map<string, Promise<void>>();
	private reads = 0;
	private readers: (() => void)[] = [];
	private reviews = new Map<string, Review>();
	private operations: Operation[] = [];
	private controllers = new Map<string, AbortController>();
	private requests = new Map<string, AbortController>();
	private requestOperations = new Map<string, string>();
	private cancelledRequests = new Map<string, number>();
	private requestContext = new AsyncLocalStorage<AbortSignal>();
	private operationWrites = Promise.resolve();
	private operationWriteQueued = false;
	private emit: (operation: Operation) => void;

	constructor(store: Store, runner: Runner, emit: (operation: Operation) => void = () => {}, vault?: Vault) {
		this.store = store;
		this.runner = runner;
		this.emit = emit;
		this.vault = vault;
	}

	async withRequest<T>(id: string | undefined, method: keyof RpcMap, work: () => Promise<T>): Promise<T> {
		if (!id || !isCancellableRpc(method)) {
			return work();
		}
		const cancelled = this.cancelledRequests.get(id);
		this.cancelledRequests.delete(id);
		if (cancelled && cancelled > Date.now()) {
			throw new SvnError({
				kind: 'cancelled',
				message: translate('common.connectionStopped'),
			});
		}
		if (this.requests.has(id)) {
			fail(translate('svn.duplicateRequestIdentifier'));
		}
		const controller = new AbortController();
		this.requests.set(id, controller);
		try {
			return await this.requestContext.run(controller.signal, async () => {
				const result = await work();
				if (method === 'checkout') {
					const operation = result as Operation;
					this.requestOperations.set(id, operation.id);
					if (this.requestOperations.size > 200) {
						this.requestOperations.delete(this.requestOperations.keys().next().value!);
					}
					if (controller.signal.aborted) {
						this.cancel(operation.id);
					}
				}
				this.assertRequestActive();
				return result;
			});
		} finally {
			this.requests.delete(id);
		}
	}

	cancelRequest(id: string): void {
		const controller = this.requests.get(id);
		const operationId = this.requestOperations.get(id);
		if (operationId) {
			this.cancel(operationId);
			this.requestOperations.delete(id);
		}
		if (controller) {
			controller.abort();
		} else {
			this.cancelledRequests.set(id, Date.now() + 60000);
			if (this.cancelledRequests.size > 200) {
				this.cancelledRequests.delete(this.cancelledRequests.keys().next().value!);
			}
		}
	}

	async initialize(): Promise<void> {
		await this.store.load();
		await uiI18n.changeLanguage(this.store.get().settings.language ?? UI_LANGUAGE);
		const comparisons = join(this.store.directory, 'comparisons');
		try {
			for (const entry of await readdir(comparisons, { withFileTypes: true })) {
				if (entry.isDirectory() && entry.name.startsWith('compare-')) {
					const target = join(comparisons, entry.name);
					if ((await lstat(target)).mtimeMs < Date.now() - 7 * 24 * 60 * 60 * 1000) {
						await rm(target, { recursive: true, force: true });
					}
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
		try {
			this.operations = JSON.parse(await readFile(join(this.store.directory, 'operations.json'), 'utf8'));
			for (const operation of this.operations) {
				if (operation.state === 'running' || operation.state === 'waiting') {
					operation.state = 'uncertain';
					operation.error = {
						kind: 'command',
						message: translate('svn.theAppClosedBeforeTheOperationFinishedRefresh'),
					};
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
		await this.runner.detect(this.store.get().settings.svnPath || undefined);
	}

	async detect(path?: string): Promise<Awaited<ReturnType<Runner['detect']>>> {
		return this.runner.detect(path || this.store.get().settings.svnPath || undefined);
	}

	async settings(patch: Partial<AppState['settings']>): Promise<AppState> {
		if (patch.svnPath !== undefined) {
			const detected = await this.runner.detect(patch.svnPath || undefined);
			if (!detected.ok) {
				fail(detected.error ?? translate('svn.invalidSvnPath'));
			}
		}
		if (patch.mergeTool && !isAbsolute(patch.mergeTool)) {
			fail(translate('svn.theMergeToolPathMustBeAbsolute'));
		}
		return this.store.change((state) => {
			Object.assign(state.settings, patch);
		});
	}

	async addWorkingCopy(path: string, name?: string): Promise<AppState> {
		const canonical = await realpath(path);
		const info = await this.infoAt(canonical);
		if (!info.rootPath) {
			fail(translate('svn.theSelectedFolderIsNotAWorkingCopy'), 'path');
		}
		const root = await realpath(info.rootPath);
		const rootInfo = canonical === root ? info : await this.infoAt(root);
		return this.store.change((state) => {
			const existing = state.workingCopies.find((copy) => copy.path === root);
			if (existing) {
				state.activeId = existing.id;
				return;
			}
			let repo = state.repositories.find((repository) => repository.uuid === info.uuid);
			if (!repo) {
				repo = {
					id: randomUUID(),
					name: basename(new URL(info.rootUrl).pathname) || translate('svn.svnRepository'),
					rootUrl: info.rootUrl,
					uuid: info.uuid,
					favorite: false,
				};
				state.repositories.push(repo);
			}
			const copy: WorkingCopy = {
				id: randomUUID(),
				name: name?.trim() || basename(root),
				path: root,
				repositoryId: repo.id,
				url: rootInfo.url,
				depth: rootInfo.depth,
				favorite: false,
			};
			state.workingCopies.push(copy);
			state.sessions[copy.id] = emptySession();
			state.activeId = copy.id;
		});
	}

	async addRepository(url: string, name?: string, credentialId?: string): Promise<AppState> {
		this.url(url);
		const repository: Repository = {
			id: randomUUID(),
			name: name?.trim() || new URL(url).hostname || basename(new URL(url).pathname) || translate('svn.svnRepository'),
			rootUrl: url,
			uuid: '',
			credentialId,
			favorite: false,
		};
		repository.credentialId ??= findCredential(this.store.get().credentials, url)?.id;
		const info = await this.infoAt(url, undefined, repository);
		repository.uuid = info.uuid;
		repository.rootUrl = info.rootUrl;
		return this.store.change((state) => {
			const existing = state.repositories.find((repo) => repo.uuid === info.uuid);
			if (existing) {
				existing.credentialId = repository.credentialId ?? existing.credentialId;
				if (name) {
					existing.name = name;
				}
			} else {
				state.repositories.push(repository);
			}
			const target = this.url(url);
			const repositoryId = existing?.id ?? repository.id;
			if (target !== this.url(info.rootUrl) && !state.bookmarks.some((bookmark) => bookmark.repositoryId === repositoryId && bookmark.url === target)) {
				state.bookmarks.push({ id: randomUUID(), repositoryId, url: target, name: decodeURIComponent(basename(new URL(target).pathname)) });
			}
		});
	}

	async bookmark(input: RpcMap['bookmark']['input']): Promise<AppState> {
		this.remoteRepo(input.url, input.repositoryId);
		const url = this.url(input.url);
		return this.store.change((state) => {
			if (input.remove) {
				state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== input.id || bookmark.repositoryId !== input.repositoryId);
				return;
			}
			if (input.direction) {
				const siblings = state.bookmarks.filter((bookmark) => bookmark.repositoryId === input.repositoryId);
				const index = siblings.findIndex((bookmark) => bookmark.id === input.id);
				if (index < 0) {
					fail(translate('svn.pathBookmarkNotFound'));
				}
				const target = siblings[index + (input.direction === 'up' ? -1 : 1)];
				if (target) {
					const first = state.bookmarks.indexOf(siblings[index]);
					const second = state.bookmarks.indexOf(target);
					[state.bookmarks[first], state.bookmarks[second]] = [state.bookmarks[second], state.bookmarks[first]];
				}
				return;
			}
			const existing = state.bookmarks.find((bookmark) => bookmark.repositoryId === input.repositoryId && (bookmark.id === input.id || bookmark.url === url));
			if (existing) {
				existing.name = input.name.trim() || decodeURIComponent(basename(new URL(url).pathname));
				existing.url = url;
			} else {
				state.bookmarks.push({
					id: randomUUID(),
					repositoryId: input.repositoryId,
					name: input.name.trim() || decodeURIComponent(basename(new URL(url).pathname)) || translate('svn.repositoryRoot'),
					url,
				});
			}
		});
	}

	async comparison(wcId: string, path: string, revision?: number): Promise<{ left: string; right: string }> {
		const wc = this.wc(wcId);
		return this.read(async () => {
			const target = await this.local(wc, path);
			if (!path || path === '.') {
				fail(translate('svn.selectAFileToCompareInFilemerge'));
			}
			let left = '';
			let right = '';
			if (revision !== undefined) {
				const url = new URL(this.url(wc.url));
				url.pathname = `${url.pathname.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`;

				const cat = async (value: number): Promise<{ text: string; exists: boolean }> => {
					if (value === 0) {
						return { text: '', exists: false };
					}
					try {
						const result = await this.command(['cat', '--revision', String(value), `${url.href}@${value}`], {}, this.repo(wc));
						return { text: result.stdout, exists: true };
					} catch (error) {
						if (error instanceof SvnError && /[EW]160013|E160006|E200009.*does not exist|non-existent|not found in revision/i.test(error.info.detail ?? '')) {
							return { text: '', exists: false };
						}
						throw error;
					}
				};

				const before = await cat(revision - 1);
				const after = await cat(revision);
				if (!before.exists && !after.exists) {
					fail(translate('svn.noComparableFileExistsAtTheSelectedRevision'));
				}
				left = before.text;
				right = after.text;
			} else {
				const snapshot = await this.scan(wc);
				const file = snapshot.files.find((entry) => entry.path === path);
				if (file?.kind === 'dir' || file?.kind === 'symlink') {
					fail(translate('svn.filemergeSupportsRegularFilesOnlySelectAFile'));
				}
				if (!file || !['added', 'unversioned', 'ignored'].includes(file.item)) {
					left = (await this.command(['cat', '--revision', 'BASE', peg(target)], { cwd: wc.path }, this.repo(wc))).stdout;
				}
				try {
					const bytes = await readFile(target);
					if (bytes.length > 32 * 1024 * 1024) {
						fail(translate('svn.theFileExceedsMibOpenItManuallyIn'));
					}
					try {
						right = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
					} catch {
						fail(translate('svn.theFileIsNotUtfTextOpenIt'));
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || (file && !['deleted', 'missing'].includes(file.item))) {
						throw error;
					}
				}
			}
			if (left.includes('\0') || right.includes('\0')) {
				fail(translate('svn.binaryFilesCannotBeComparedAsTextIn'));
			}
			const directory = join(this.store.directory, 'comparisons');
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const temporary = await mkdtemp(join(directory, 'compare-'));
			const extension = extname(path);
			const stem = basename(path, extension);
			const leftPath = join(temporary, `${stem}.${revision === undefined ? 'BASE' : `r${revision - 1}`}${extension}`);
			const rightPath = join(temporary, `${stem}.${revision === undefined ? 'WORKING' : `r${revision}`}${extension}`);
			await writeFile(leftPath, left, { mode: 0o400 });
			await writeFile(rightPath, right, { mode: 0o400 });
			return { left: leftPath, right: rightPath };
		});
	}

	async manage(input: RpcMap['manage']['input']): Promise<AppState> {
		return this.store.change((state) => {
			const collection: { id: string; name: string; groupId?: string; favorite?: boolean; credentialId?: string }[] =
				input.entity === 'workingCopy' ? state.workingCopies : input.entity === 'repository' ? state.repositories : state.groups;
			if (!input.id) {
				if (input.entity !== 'group' || !input.name?.trim()) {
					fail(translate('svn.enterAGroupName'));
				}
				state.groups.push({ id: randomUUID(), name: input.name!.trim() });
				return;
			}
			const index = collection.findIndex((item) => item.id === input.id);
			if (index < 0) {
				fail(translate('svn.managementRecordNotFound'));
			}
			if (input.remove) {
				if (input.entity === 'repository' && state.workingCopies.some((copy) => copy.repositoryId === input.id)) {
					fail(translate('svn.removeTheWorkingCopyRecordsLinkedToThis'));
				}
				if (input.entity === 'workingCopy' && this.operations.some((op) => op.wcId === input.id && ['running', 'waiting'].includes(op.state))) {
					fail(translate('svn.waitForThisWorkingCopySOperationTo'));
				}
				collection.splice(index, 1);
				if (input.entity === 'repository') {
					state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.repositoryId !== input.id);
				}
				if (input.entity === 'workingCopy') {
					delete state.sessions[input.id!];
					if (state.activeId === input.id) {
						state.activeId = state.workingCopies[0]?.id;
					}
				}
				if (input.entity === 'group') {
					for (const item of [...state.workingCopies, ...state.repositories]) {
						if (item.groupId === input.id) {
							delete item.groupId;
						}
					}
				}
				return;
			}
			const item = collection[index];
			if (input.name?.trim()) {
				item.name = input.name.trim();
			}
			if (input.favorite !== undefined) {
				item.favorite = input.favorite;
			}
			if (input.groupId !== undefined) {
				if (input.groupId && !state.groups.some((group) => group.id === input.groupId)) {
					fail(translate('svn.groupNotFound'));
				}
				item.groupId = input.groupId || undefined;
			}
			if (input.credentialId !== undefined) {
				if (input.credentialId && !state.credentials.some((profile) => profile.id === input.credentialId)) {
					fail(translate('svn.credentialProfileNotFound'));
				}
				item.credentialId = input.credentialId || undefined;
			}
			if (input.direction) {
				const other = index + (input.direction === 'up' ? -1 : 1);
				if (other >= 0 && other < collection.length) {
					[collection[index], collection[other]] = [collection[other], collection[index]];
				}
			}
		});
	}

	async saveSession(wcId: string, patch: Partial<AppState['sessions'][string]>): Promise<AppState['sessions'][string]> {
		this.wc(wcId);
		const state = await this.store.change((data) => {
			data.sessions[wcId] = { ...(data.sessions[wcId] ?? emptySession()), ...patch };
		});
		return state.sessions[wcId];
	}

	async status(wcId: string, remote = false): Promise<Snapshot> {
		try {
			const snapshot = await this.read(() => this.scan(this.wc(wcId), remote));
			await this.store.change((state) => {
				const copy = state.workingCopies.find((copy) => copy.id === wcId);
				if (copy) {
					copy.lastScan = snapshot.scannedAt;
					copy.changeCount = snapshot.files.filter(isChanged).length;
					copy.conflicts = snapshot.files.filter(isConflict).length;
					delete copy.error;
				}
			});
			return snapshot;
		} catch (error) {
			await this.store.change((state) => {
				const copy = state.workingCopies.find((copy) => copy.id === wcId);
				if (copy) {
					copy.error = error instanceof Error ? error.message : String(error);
				}
			});
			throw error;
		}
	}

	async info(wcId: string, path: string): Promise<SvnInfo> {
		const wc = this.wc(wcId);
		return this.read(async () => this.infoAt(await this.local(wc, path), wc.path, this.repo(wc)));
	}

	async properties(wcId: string, path: string): Promise<Property[]> {
		const wc = this.wc(wcId);
		return this.read(async () => {
			const target = await this.local(wc, path);
			const result = await this.command(['proplist', '--xml', '--verbose', peg(target)], { cwd: wc.path }, this.repo(wc));
			return arr<any>(parser.parse(result.stdout).properties?.target?.property).map((property) => ({ name: property.name, value: str(property) }));
		});
	}

	async diff(wcId: string, path: string, revision?: number): Promise<{ text: string; unsupported?: string }> {
		const wc = this.wc(wcId);
		return this.read(async () => {
			if (revision !== undefined) {
				await this.local(wc, path || '.');
				const target = new URL(this.url(wc.url));
				if (path && path !== '.') {
					target.pathname = `${target.pathname.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`;
				}
				const result = await this.command(['diff', '-c', String(revision), `${target.href}@${revision}`], {}, this.repo(wc));
				return {
					text: result.stdout,
					unsupported: /Cannot display: file marked as a binary type/.test(result.stdout) ? translate('svn.textPreviewIsUnavailableForBinaryFiles') : undefined,
				};
			}
			const target = await this.local(wc, path);
			const { stdout } = await this.command(['diff', '--ignore-properties', '--', target], { cwd: wc.path }, this.repo(wc));
			const properties = await this.command(['diff', '--properties-only', '--', target], { cwd: wc.path }, this.repo(wc));
			return {
				text: (stdout + properties.stdout).replaceAll(`${wc.path}/`, ''),
				unsupported: /Cannot display: file marked as a binary type/.test(stdout) ? translate('svn.textPreviewIsUnavailableForBinaryFiles') : undefined,
			};
		});
	}

	async log(wcId: string, path = '.', before?: number): Promise<LogEntry[]> {
		if (before === 0) {
			return [];
		}
		const wc = this.wc(wcId);
		return this.read(async () => {
			await this.local(wc, path);
			const root = new URL(this.url(wc.url));
			if (path !== '.') {
				root.pathname = `${root.pathname.replace(/\/$/, '')}/${path.split('/').map(encodeURIComponent).join('/')}`;
			}
			const result = await this.command(['log', '--xml', '--verbose', '--limit', '50', '-r', `${before ?? 'HEAD'}:0`, peg(root.href)], {}, this.repo(wc));
			return arr<any>(parser.parse(result.stdout).log?.logentry).map((entry) => ({
				revision: Number(entry.revision),
				author: str(entry.author),
				date: str(entry.date),
				message: str(entry.msg),
				paths: arr<any>(entry.paths?.path).map((path) => ({ path: str(path), action: path.action, kind: path.kind ?? '', copyFrom: path['copyfrom-path'] })),
			}));
		});
	}

	async list(url: string, repositoryId?: string): Promise<RemoteEntry[]> {
		const repo = this.remoteRepo(url, repositoryId);
		return this.read(async () => {
			const result = await this.command(['list', '--xml', peg(this.url(url))], {}, repo);
			return arr<any>(parser.parse(result.stdout).lists?.list?.entry).map((entry) => ({
				name: str(entry.name),
				kind: entry.kind,
				size: Number(entry.size ?? 0),
				revision: entry.commit?.revision ?? '',
				author: str(entry.commit?.author),
				date: str(entry.commit?.date),
			}));
		});
	}

	async checkout(input: RpcMap['checkout']['input']): Promise<Operation> {
		const repo = this.remoteRepo(input.url, input.repositoryId);
		await this.infoAt(this.url(input.url), undefined, repo);
		if (!isAbsolute(input.destination) || input.destination === '/') {
			fail(translate('svn.chooseAValidAbsoluteDestinationPath'));
		}
		const destination = resolve(await realpath(dirname(input.destination)), basename(input.destination));
		let ancestor = dirname(destination);
		while (ancestor !== dirname(ancestor)) {
			try {
				if ((await lstat(join(ancestor, '.svn'))).isDirectory()) {
					fail(translate('svn.theCheckoutDestinationCannotBeInsideAnExisting'));
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
			}
			ancestor = dirname(ancestor);
		}
		try {
			await lstat(destination);
			fail(translate('svn.theCheckoutDestinationMustNotExistToAvoid'));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
		if (this.store.get().workingCopies.some((copy) => destination === copy.path || destination.startsWith(copy.path + sep))) {
			fail(translate('svn.checkOutToAFolderOutsideManagedWorking'));
		}
		this.assertRequestActive();
		return this.enqueue(`checkout:${destination}`, undefined, 'checkout', async (signal, log) => {
			try {
				await lstat(destination);
				fail(translate('svn.theDestinationAlreadyExistsChooseAnotherPath'));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
			}
			await this.command(
				['checkout', '--ignore-externals', '--depth', input.depth, peg(this.url(input.url)), destination],
				{ signal, onData: log, timeout: 60 * 60 * 1000 },
				repo,
			);
			await this.addWorkingCopy(destination);
		});
	}

	async review(input: RpcMap['review']['input']): Promise<Review> {
		const wc = this.wc(input.wcId);
		if (!input.paths.length && !['update', 'cleanup'].includes(input.action)) {
			fail(translate('svn.selectAnOperationTarget'));
		}
		for (const path of input.paths) {
			await this.local(wc, path);
		}
		const snapshot = await this.scan(wc);
		if (
			snapshot.files.some(
				(file) =>
					file.external &&
					input.paths.some((path) => contains(file.path, path) || (['delete', 'rename', 'revert', 'add'].includes(input.action) && contains(path, file.path))),
			)
		) {
			fail(translate('svn.theScopeIncludesAnExternalManageDirectoryExternals'));
		}
		let paths = [...new Set(input.paths)];
		const reasons: string[] = [];
		if (input.action === 'commit') {
			if (!input.message?.trim()) {
				fail(translate('svn.enterACommitMessage'));
			}
			const tracked = snapshot.files.filter(isChanged);
			for (const path of paths) {
				if (!tracked.some((file) => file.path === path)) {
					fail(
						translate('svn.fileStatusHasChangedRefreshFirst', {
							path: path,
						}),
						'stale',
					);
				}
			}
			const selected = new Set(paths);
			let added = true;
			while (added) {
				added = false;
				for (const file of tracked) {
					const mandatory = [...selected].some((path) => {
						const source = tracked.find((item) => item.path === path);
						return (
							(file.item === 'added' && contains(file.path, path)) ||
							(source?.kind === 'dir' && ['added', 'deleted', 'replaced'].includes(source.item) && contains(path, file.path)) ||
							source?.movedFrom === file.path ||
							source?.movedTo === file.path
						);
					});
					if (mandatory && !selected.has(file.path)) {
						selected.add(file.path);
						reasons.push(
							translate('svn.relatedPathAddedParentDirectoryDescendantOrOther', {
								path: file.path,
							}),
						);
						added = true;
					}
				}
			}
			paths = [...selected];
			if (snapshot.files.some((file) => paths.includes(file.path) && (isConflict(file) || ['missing', 'obstructed', 'incomplete'].includes(file.item)))) {
				fail(translate('svn.theCommitScopeIncludesConflictedMissingOrObstructed'));
			}
		} else if (['revert', 'delete', 'add'].includes(input.action)) {
			for (const file of snapshot.files) {
				if (paths.some((path) => contains(path, file.path)) && !paths.includes(file.path) && (isChanged(file) || file.item === 'unversioned' || file.item === 'ignored')) {
					paths.push(file.path);
				}
			}
		}
		if (['add', 'delete', 'rename'].includes(input.action)) {
			const diskPaths: string[] = [];

			const visit = async (path: string): Promise<void> => {
				if (diskPaths.length > 2000) {
					fail(translate('svn.theScopeExceedsDiskEntriesSelectASmaller'));
				}
				diskPaths.push(path);
				const target = await this.local(wc, path);
				try {
					if ((await lstat(target)).isDirectory()) {
						for (const name of (await readdir(target)).sort()) {
							if (name !== '.svn') {
								await visit(normalized(join(path, name)));
							}
						}
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						throw error;
					}
				}
			};

			for (const path of input.paths) {
				await visit(path);
			}
			paths = [...new Set([...paths, ...diskPaths])];
			if (diskPaths.length > input.paths.length) {
				reasons.push(translate('svn.thisDirectoryOperationIncludesTheFollowingDescendantsOn'));
			}
		}
		if (input.action === 'add') {
			for (const path of input.paths) {
				let ancestor = normalized(dirname(path));
				while (ancestor !== '.') {
					const entry = snapshot.files.find((file) => file.path === ancestor);
					if (entry && !['unversioned', 'ignored'].includes(entry.item)) {
						break;
					}
					if (!paths.includes(ancestor)) {
						paths.push(ancestor);
						reasons.push(
							translate('svn.addingToVersionControlRequiresThisParentDirectory', {
								ancestor: ancestor,
							}),
						);
					}
					ancestor = normalized(dirname(ancestor));
				}
			}
		}
		if (input.action === 'rename') {
			if (input.paths.length !== 1 || input.paths[0] === '.') {
				fail(translate('svn.selectOneFileOrDirectoryToRename'));
			}
			if (!input.destination) {
				fail(translate('svn.enterANewRelativePath'));
			}
			const target = await this.local(wc, input.destination!);
			try {
				await lstat(target);
				fail(translate('svn.theDestinationExistsAndCannotBeOverwritten'));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
			}
			paths.push(input.destination!);
			reasons.push(
				translate('svn.moveDestination', {
					destination: input.destination,
				}),
			);
		}
		if (input.action === 'ignore') {
			const parents = [...new Set(input.paths.map((path) => normalized(dirname(path))))];
			for (const path of parents) {
				if (!paths.includes(path)) {
					paths.push(path);
					reasons.push(
						translate('svn.theSvnIgnorePropertyOfParentDirectoryWill', {
							path: path,
						}),
					);
				}
			}
			for (const path of input.paths) {
				if (/[\r\n*?\[\]]/.test(basename(path))) {
					fail(translate('svn.thisFilenameContainsSvnIgnoreWildcardsAndCannot'));
				}
			}
		}
		if (['delete', 'rename'].includes(input.action) && paths.includes('.')) {
			fail(translate('svn.theWorkingCopyRootCannotBeUsedFor'));
		}
		if (paths.length > 2000) {
			fail(translate('svn.theOperationExceedsPathsSelectASmallerScope'));
		}
		const review: Review = {
			id: randomUUID(),
			wcId: wc.id,
			action: input.action,
			paths: paths.sort(),
			requested: [...new Set(input.paths)],
			reasons,
			createdAt: new Date().toISOString(),
			fingerprint: await this.fingerprint(wc, snapshot, paths),
			destination: input.destination,
			message: input.message,
		};
		if (['revert', 'delete'].includes(input.action)) {
			review.warning =
				input.action === 'revert' ? translate('svn.revertingDiscardsUncommittedTextAndPropertyChangesIn') : translate('svn.deletingRemovesDiskContentAndSchedulesAnSvn');
		}
		if (input.action === 'resolve') {
			review.warning = translate('svn.markResolvedOnlyAfterManuallyMergingAndSaving');
		}
		if (input.action === 'cleanup') {
			review.warning = translate('svn.makeSureNoOtherSvnClientIsUsing');
		}
		if (input.action === 'update') {
			review.warning = translate('svn.updatingAppliesServerChangesAndMayCauseConflicts');
		}
		if (this.reviews.size > 100) {
			this.reviews.delete(this.reviews.keys().next().value!);
		}
		this.reviews.set(review.id, review);
		return structuredClone(review);
	}

	async execute(reviewId: string): Promise<Operation> {
		const review = this.reviews.get(reviewId) ?? fail(translate('svn.thisReviewHasExpiredReviewTheScopeAgain'), 'stale');
		const wc = this.wc(review.wcId);
		if (['commit', 'update'].includes(review.action) && new URL(wc.url).protocol !== 'file:') {
			await this.infoAt(wc.url, undefined, this.repo(wc));
		}
		if (this.reviews.get(reviewId) !== review) {
			fail(translate('svn.thisReviewWasAlreadyExecutedReviewTheScope'), 'stale');
		}
		this.reviews.delete(reviewId);

		return this.enqueue(wc.path, wc.id, review.action, async (signal, log) => {
			const snapshot = await this.scan(wc);
			if ((await this.fingerprint(wc, snapshot, review.paths)) !== review.fingerprint) {
				fail(translate('svn.filesOrPropertiesChangedAfterReviewRefreshAnd'), 'stale');
			}
			if (Date.now() - new Date(review.createdAt).getTime() > 10 * 60 * 1000) {
				fail(translate('svn.thisReviewIsOverTenMinutesOldReview'), 'stale');
			}
			for (const path of review.paths) {
				await this.local(wc, path);
			}
			const targets = review.paths.map((path) => peg(resolve(wc.path, path)));
			const options = { cwd: wc.path, signal, onData: log, timeout: 60 * 60 * 1000 };
			const repo = this.repo(wc);
			if (review.action === 'commit') {
				const messageFile = join(this.store.directory, `message-${review.id}.txt`);
				await writeFile(messageFile, review.message!, { mode: 0o600 });
				try {
					await this.command(['commit', '--depth', 'empty', '--file', messageFile, '--', ...targets], options, repo);
				} finally {
					const { unlink } = await import('node:fs/promises');
					await unlink(messageFile).catch(() => {});
				}
				await this.store.change((state) => {
					state.recentMessages = [review.message!, ...state.recentMessages.filter((message) => message !== review.message)].slice(0, 20);
					const session = state.sessions[wc.id];
					if (session.draft === review.message) {
						session.draft = '';
					}
					session.selected = session.selected.filter((path) => !review.paths.includes(path));
				});
			} else if (review.action === 'update') {
				await this.command(['update', '--ignore-externals', peg(wc.path)], options, repo);
			} else if (review.action === 'cleanup') {
				await this.command(['cleanup', peg(wc.path)], options, repo);
			} else if (review.action === 'rename') {
				await this.command(['move', peg(resolve(wc.path, review.requested[0])), resolve(wc.path, review.destination!)], options, repo);
			} else if (review.action === 'ignore') {
				for (const path of review.requested) {
					const parent = dirname(path);
					const parentTarget = await this.local(wc, parent);
					const xml = await this.command(['proplist', '--xml', '--verbose', peg(parentTarget)], options, repo);
					const properties = arr<any>(parser.parse(xml.stdout).properties?.target?.property);
					const current = str(properties.find((property) => property.name === 'svn:ignore'));
					const value = [...new Set([...current.split('\n').filter(Boolean), basename(path)])].join('\n');
					await this.command(['propset', 'svn:ignore', value, peg(parentTarget)], options, repo);
				}
			} else {
				const roots = review.requested
					.filter((path) => !review.requested.some((other) => other !== path && contains(other, path)))
					.map((path) => peg(resolve(wc.path, path)));
				const args =
					review.action === 'resolve'
						? ['resolve', '--accept', 'working', '--depth', 'empty']
						: review.action === 'revert'
							? ['revert', '--depth', 'infinity']
							: review.action === 'add'
								? ['add', '--parents', '--no-ignore']
								: ['delete', '--force'];
				await this.command([...args, '--', ...roots], options, repo);
			}
			const fresh = await this.scan(wc);
			const conflicts = fresh.files.filter(isConflict);
			if (conflicts.length && review.action === 'update') {
				log(
					translate('operations.updateConflicts', {
						count: conflicts.length,
					}),
				);
			}
			await this.store.change((state) => {
				const copy = state.workingCopies.find((item) => item.id === wc.id);
				if (copy) {
					copy.lastScan = fresh.scannedAt;
					copy.changeCount = fresh.files.filter(isChanged).length;
					copy.conflicts = conflicts.length;
				}
			});
			return conflicts.length;
		});
	}

	getOperations(): Operation[] {
		return structuredClone(this.operations);
	}

	async clearOperations(input: RpcMap['clearOperations']['input']): Promise<RpcMap['clearOperations']['output']> {
		const requested = new Set(input.ids);
		const eligible = new Set(this.operations.filter((operation) => requested.has(operation.id) && !isOperationActive(operation)).map((operation) => operation.id));
		let removedIds: string[] = [];
		const task = this.operationWrites
			.catch(() => {})
			.then(async () => {
				const removed = new Set(this.operations.filter((operation) => eligible.has(operation.id) && !isOperationActive(operation)).map((operation) => operation.id));
				if (!removed.size) {
					return;
				}
				await this.writeOperations(this.operations.filter((operation) => !removed.has(operation.id)));
				// Preserve tasks and output added while the atomic file write was in flight.
				this.operations = this.operations.filter((operation) => !removed.has(operation.id));
				removedIds = [...removed];
			});
		this.operationWrites = task;
		await task;
		return { removedIds, operations: this.getOperations() };
	}

	cancel(id: string): void {
		this.controllers.get(id)?.abort();
	}

	public authentication(input: RpcMap['authentication']['input']): RpcMap['authentication']['output'] {
		let url = input.url;
		let repository: Repository | undefined;
		if (input.reviewId) {
			const review = this.reviews.get(input.reviewId) ?? fail(translate('svn.thisReviewHasExpiredReviewTheScopeAgain'), 'stale');
			if (!['commit', 'update'].includes(review.action)) {
				return null;
			}
			const wc = this.wc(review.wcId);
			url = wc.url;
			repository = this.repo(wc);
		} else if (input.wcId) {
			const wc = this.wc(input.wcId);
			url = wc.url;
			repository = this.repo(wc);
		} else if (url) {
			repository = this.remoteRepo(url, input.repositoryId);
		}
		if (!url) {
			fail(translate('svn.missingAuthenticationTarget'));
		}
		if (svnAddress(url!).protocol === 'file:') {
			return null;
		}
		const profile = findCredential(this.store.get().credentials, url!, repository?.credentialId);
		return {
			url: this.url(url!),
			rootUrl: profile?.rootUrl ?? connectionRoot(url!),
			username: decodeURIComponent(svnAddress(url!).username) || profile?.username || '',
			credentialId: profile?.id,
			repositoryRoot: repository?.rootUrl ?? credentialRoot(url!),
			reason: profile ? undefined : 'missing',
		};
	}

	async credentialForEdit(input: RpcMap['credentialForEdit']['input']): Promise<RpcMap['credentialForEdit']['output']> {
		const target = this.url(input.url);
		const root = credentialRoot(input.rootUrl);
		const profile = findCredential(this.store.get().credentials, target, input.id);
		if (!profile || profile.id !== input.id || profile.rootUrl !== root) {
			fail(translate('svn.thisCredentialProfileDoesNotBelongToThe'));
		}
		if (!this.vault) {
			fail(translate('svn.systemSecureStorageIsUnavailableCredentialsCouldNot'));
		}
		// Only the explicit editor receives this value; catalog and authentication context stay secret-free.
		return { username: profile!.username, password: (await this.vault!.get(profile!.id)) ?? '' };
	}

	async credential(input: RpcMap['credential']['input']): Promise<AppState> {
		if (!this.vault) {
			fail(translate('svn.systemSecureStorageIsUnavailableThePasswordCannot'));
		}
		const rootUrl = credentialRoot(input.rootUrl);
		if (svnAddress(rootUrl).protocol === 'file:') {
			fail(translate('svn.localFileRepositoriesDoNotNeedAConnection'));
		}
		const existing = input.id
			? this.store.get().credentials.find((profile) => profile.id === input.id)
			: this.store.get().credentials.find((profile) => profile.rootUrl === rootUrl && profile.username === input.username);
		if (input.id && (!existing || existing.rootUrl !== rootUrl)) {
			fail(translate('svn.thisCredentialProfileDoesNotBelongToThe2'));
		}
		const id = existing?.id ?? randomUUID();
		if (input.remove) {
			if (!existing) {
				fail(translate('svn.noCredentialsAreSavedForThisConnection'));
			}
			await this.vault!.delete(id);
			return this.store.change((state) => {
				state.credentials = state.credentials.filter((profile) => profile.id !== id);
				for (const repo of state.repositories) {
					if (repo.credentialId === id) {
						delete repo.credentialId;
					}
				}
			});
		}
		if (!input.username.trim() || !input.password || /[\r\n\0]/.test(input.username + input.password)) {
			fail(translate('svn.enterAValidUsernameAndPasswordWithoutLine'));
		}
		const target = this.url(input.url ?? rootUrl);
		if (!withinCredentialRoot(rootUrl, target)) {
			fail(translate('svn.theVerificationUrlIsOutsideTheCredentialScope'));
		}
		await this.vault!.set(id, input.password);
		return this.store.change((state) => {
			state.credentials = [
				...state.credentials.filter((profile) => profile.id !== id),
				{ id, name: input.name || `${input.username} · ${rootUrl}`, username: input.username, rootUrl },
			];
			for (const repo of state.repositories) {
				if (withinCredentialRoot(rootUrl, repo.rootUrl)) {
					repo.credentialId = findCredential(state.credentials, repo.rootUrl, repo.credentialId)?.id;
				}
			}
		});
	}

	async systemPath(wcId: string, path: string): Promise<string> {
		return this.local(this.wc(wcId), path);
	}

	async flush(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.operationWrites;
			await pending;
		} while (pending !== this.operationWrites);
	}

	private assertRequestActive(): void {
		if (this.requestContext.getStore()?.aborted) {
			throw new SvnError({
				kind: 'cancelled',
				message: translate('common.connectionStopped'),
			});
		}
	}

	private wc(id: string): WorkingCopy {
		return this.store.get().workingCopies.find((copy) => copy.id === id) ?? fail(translate('svn.workingCopyRecordNotFound'));
	}

	private repo(wc: WorkingCopy): Repository | undefined {
		const repository = this.store.get().repositories.find((repo) => repo.id === wc.repositoryId);
		return repository ? { ...repository, rootUrl: wc.url } : undefined;
	}

	private url(value: string): string {
		try {
			return svnAddress(value).href;
		} catch {
			return fail(translate('svn.enterACompleteSvnUrlItMayInclude'));
		}
	}

	private remoteRepo(url: string, id?: string): Repository | undefined {
		url = this.url(url);
		if (!id) {
			return { id: '', rootUrl: url, uuid: '', name: '', favorite: false };
		}
		const repo = this.store.get().repositories.find((repo) => repo.id === id) ?? fail(translate('svn.repositoryNotFound'));
		if (!withinCredentialRoot(repo.rootUrl, url)) {
			fail(translate('svn.theBrowseUrlIsOutsideThisRepositoryRoot'));
		}
		return { ...repo, rootUrl: url };
	}

	private async local(wc: WorkingCopy, path: string): Promise<string> {
		if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..' || part.toLowerCase() === '.svn') || /[\r\n\0]/.test(path)) {
			fail(translate('svn.theTargetPathIsOutsideTheAllowedScope'));
		}
		const target = resolve(wc.path, path);
		if (target !== wc.path && !target.startsWith(wc.path + sep)) {
			fail(translate('svn.theTargetPathIsOutsideTheWorkingCopy'));
		}
		let ancestor = target;
		try {
			if ((await lstat(target)).isSymbolicLink()) {
				ancestor = dirname(target);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
		while (true) {
			try {
				const actual = await realpath(ancestor);
				if (actual !== wc.path && !actual.startsWith(wc.path + sep)) {
					fail(translate('svn.theTargetSSymbolicLinkPointsOutsideThe'));
				}
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
				if (ancestor === wc.path) {
					fail(translate('svn.theWorkingCopyRootIsNoLongerAccessible'), 'path');
				}
				ancestor = dirname(ancestor);
			}
		}
		let check = target;
		while (true) {
			const nested = join(check, '.svn');
			try {
				if (check !== wc.path && (await lstat(nested)).isDirectory()) {
					fail(translate('svn.thisTargetBelongsToANestedWorkingCopy'));
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
					throw error;
				}
			}
			if (check === wc.path) {
				break;
			}
			check = dirname(check);
		}
		return target;
	}

	private async command(args: string[], options: Parameters<Runner['run']>[1] = {}, repository?: Repository): Promise<{ stdout: string; stderr: string }> {
		const target =
			args
				.slice(1)
				.find((value) => /^(file|https?|svn|svn\+ssh):\/\//.test(value))
				?.replace(/@(?:\d+)?$/, '') ?? repository?.rootUrl;
		let hint = target;
		if (target && repository) {
			const address = svnAddress(target);
			const parent = svnAddress(repository.rootUrl);
			if (!address.username && withinCredentialRoot(connectionRoot(parent.href), address.href)) {
				address.username = parent.username;
			}
			hint = address.href;
		}
		const profile = hint ? findCredential(this.store.get().credentials, hint, repository?.credentialId) : undefined;
		const password = profile ? await this.vault?.get(profile.id) : undefined;
		const username = profile?.username || (hint ? decodeURIComponent(svnAddress(hint).username) : '');
		const auth = username ? ['--username', username, ...(password !== undefined ? ['--password-from-stdin'] : [])] : [];

		const hide = (text: string): string => redact(password ? text.replaceAll(password, translate('svn.hidden')) : text);

		try {
			const networkRead = target && svnAddress(target).protocol !== 'file:' && ['info', 'list', 'log', 'diff', 'status', 'cat', 'proplist'].includes(args[0]);
			this.assertRequestActive();
			const result = await this.runner.run([args[0], '--non-interactive', '--no-auth-cache', ...auth, ...args.slice(1)], {
				...options,
				signal: options.signal ?? this.requestContext.getStore(),
				timeout: options.timeout ?? (networkRead ? 30000 : undefined),
				password,
				onData: options.onData ? (text) => options.onData!(hide(text)) : undefined,
			});
			this.assertRequestActive();
			return result;
		} catch (error) {
			if (error instanceof SvnError) {
				const context =
					error.info.kind === 'auth' && target
						? {
								url: target,
								rootUrl: profile?.rootUrl ?? connectionRoot(target),
								username,
								credentialId: profile?.id,
								repositoryRoot: repository?.id ? this.store.get().repositories.find((repo) => repo.id === repository.id)?.rootUrl : credentialRoot(target),
								reason: 'rejected' as const,
								retrySafe: ['info', 'list', 'log', 'diff', 'status', 'cat', 'proplist'].includes(args[0]),
							}
						: undefined;
				throw new SvnError({ ...error.info, message: hide(error.info.message), detail: error.info.detail ? hide(error.info.detail) : undefined, auth: context });
			}
			throw error;
		}
	}

	private async infoAt(target: string, cwd?: string, repository?: Repository): Promise<SvnInfo> {
		const result = await this.command(['info', '--xml', peg(target)], { cwd }, repository);
		const entry = parser.parse(result.stdout).info?.entry;
		if (!entry) {
			fail(translate('svn.unableToReadSvnWorkingCopyInformation'));
		}
		return {
			path: entry.path,
			rootPath: str(entry['wc-info']?.['wcroot-abspath']),
			url: str(entry.url),
			rootUrl: str(entry.repository?.root),
			uuid: str(entry.repository?.uuid),
			revision: entry.revision,
			depth: str(entry['wc-info']?.depth) || 'infinity',
			kind: entry.kind,
			conflicts: [...arr<Record<string, unknown>>(entry.conflict), ...arr<Record<string, unknown>>(entry['tree-conflict'])],
		};
	}

	private async scan(wc: WorkingCopy, remote = false): Promise<Snapshot> {
		await this.local(wc, '.');
		const result = await this.command(
			['status', '--xml', '--verbose', '--no-ignore', '--ignore-externals', ...(remote ? ['--show-updates'] : []), peg(wc.path)],
			{ cwd: wc.path },
			this.repo(wc),
		);
		const target = parser.parse(result.stdout).status?.target;
		const entries = arr<any>(target?.entry);
		const files: FileStatus[] = [];
		let remoteChanges = 0;
		for (const entry of entries) {
			const status = entry['wc-status'];
			if (!status) {
				continue;
			}
			if (entry['repos-status'] && (entry['repos-status'].item !== 'none' || entry['repos-status'].props !== 'none')) {
				remoteChanges++;
			}
			const path = normalized(relative(wc.path, isAbsolute(entry.path) ? entry.path : resolve(wc.path, entry.path)));
			if (path === '..' || path.startsWith('../')) {
				continue;
			}
			let kind = 'unknown';
			try {
				const stat = await lstat(resolve(wc.path, path));
				kind = stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'symlink' : 'file';
			} catch {
				if (['deleted', 'missing', 'replaced'].includes(status.item)) {
					try {
						kind = (await this.infoAt(resolve(wc.path, path), wc.path, this.repo(wc))).kind;
					} catch {
						/* Preserve the missing state if metadata is unavailable. */
					}
				}
			}
			const movedFrom = status['moved-from'] ? normalized(relative(wc.path, resolve(wc.path, status['moved-from']))) : undefined;
			const movedTo = status['moved-to'] ? normalized(relative(wc.path, resolve(wc.path, status['moved-to']))) : undefined;
			files.push({
				path,
				item: status.item,
				props: status.props,
				revision: status.revision ?? '',
				author: str(status.commit?.author),
				date: str(status.commit?.date),
				kind,
				copied: status.copied === 'true',
				switched: status.switched === 'true',
				treeConflicted: status['tree-conflicted'] === 'true',
				movedFrom,
				movedTo,
				external: status.item === 'external' || status['file-external'] === 'true',
			});
		}
		files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
		return {
			wcId: wc.id,
			files,
			scannedAt: new Date().toISOString(),
			fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
			remote,
			remoteRevision: target?.against?.revision,
			remoteChanges: remote ? remoteChanges : undefined,
		};
	}

	private async fingerprint(wc: WorkingCopy, snapshot: Snapshot, paths: string[]): Promise<string> {
		const hash = createHash('sha256').update(snapshot.fingerprint);
		const visited = new Set<string>();

		const visit = async (path: string): Promise<void> => {
			if (visited.has(path)) {
				return;
			}
			visited.add(path);
			if (visited.size > 50000) {
				fail(translate('svn.theOperationExceedsDiskEntriesSelectASmaller'));
			}
			const target = await this.local(wc, path);
			hash.update(path);
			try {
				const stat = await lstat(target);
				hash.update(`${stat.mode}:${stat.size}:${stat.mtimeMs}`);
				if (stat.isDirectory()) {
					for (const name of (await readdir(target)).sort()) {
						if (name !== '.svn') {
							await visit(normalized(join(path, name)));
						}
					}
				} else if (stat.isSymbolicLink()) {
					hash.update(await readlink(target));
				} else if (stat.isFile()) {
					for await (const chunk of createReadStream(target)) {
						hash.update(chunk);
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
				hash.update('missing');
			}
		};

		for (const path of paths) {
			await visit(path);
		}
		for (const file of snapshot.files) {
			if (['modified', 'conflicted'].includes(file.props) && paths.some((path) => contains(path, file.path))) {
				const result = await this.command(['proplist', '--xml', '--verbose', peg(resolve(wc.path, file.path))], { cwd: wc.path }, this.repo(wc));
				hash.update(result.stdout);
			}
		}
		return hash.digest('hex');
	}

	private async read<T>(callback: () => Promise<T>): Promise<T> {
		if (this.reads >= 3) {
			await new Promise<void>((resolve) => this.readers.push(resolve));
		} else {
			this.reads++;
		}
		try {
			return await callback();
		} finally {
			const next = this.readers.shift();
			if (next) {
				next();
			} else {
				this.reads--;
			}
		}
	}

	private async enqueue(
		key: string,
		wcId: string | undefined,
		action: NonNullable<Operation['action']>,
		work: (signal: AbortSignal, log: (text: string) => void) => Promise<void | number>,
	): Promise<Operation> {
		const operation: Operation = {
			id: randomUUID(),
			wcId,
			label: operationLabel({ action, label: '' }),
			action,
			state: 'waiting',
			sequence: 0,
			startedAt: new Date().toISOString(),
			logs: [],
		};
		const commit = action === 'commit';
		const controller = new AbortController();
		this.controllers.set(operation.id, controller);
		this.operations.unshift(operation);
		this.operations = [
			...this.operations.filter((op) => ['running', 'waiting'].includes(op.state)),
			...this.operations.filter((op) => !['running', 'waiting'].includes(op.state)).slice(0, 100),
		];
		this.publish(operation);
		const previous = this.queues.get(key) ?? Promise.resolve();
		const task = previous
			.catch(() => {})
			.then(async () => {
				let started = false;
				try {
					if (controller.signal.aborted) {
						throw new SvnError({
							kind: 'cancelled',
							message: translate('svn.queuedOperationCancelled'),
						});
					}
					operation.state = 'running';
					this.publish(operation);
					started = true;
					const conflicts = await work(controller.signal, (text) => {
						appendOperationLog(operation.logs, redact(text));
						this.publish(operation);
					});
					operation.conflictCount = typeof conflicts === 'number' ? conflicts : 0;
					operation.state = 'success';
				} catch (error) {
					const info = error instanceof SvnError ? error.info : classify(String(error));
					operation.error = info;
					operation.state =
						commit && started && !['stale', 'validation', 'path', 'conflict', 'auth', 'certificate', 'outdated'].includes(info.kind)
							? 'uncertain'
							: info.kind === 'cancelled'
								? 'cancelled'
								: 'failed';
					if (operation.state === 'uncertain') {
						operation.logs.push(translate('operations.uncertainCommit'));
					}
				} finally {
					operation.endedAt = new Date().toISOString();
					this.controllers.delete(operation.id);
					this.publish(operation);
				}
			});
		this.queues.set(key, task);
		void task.finally(() => {
			if (this.queues.get(key) === task) {
				this.queues.delete(key);
			}
		});
		return structuredClone(operation);
	}

	private publish(operation: Operation): void {
		operation.sequence = (operation.sequence ?? 0) + 1;
		this.emit(structuredClone(operation));
		if (this.operationWriteQueued) {
			return;
		}
		this.operationWriteQueued = true;
		this.operationWrites = this.operationWrites
			.catch(() => {})
			.then(async () => {
				// A burst needs one pending snapshot; output arriving during I/O schedules the next.
				this.operationWriteQueued = false;
				await this.writeOperations(this.operations);
			});
		void this.operationWrites.catch(() => {});
	}

	private async writeOperations(operations: Operation[]): Promise<void> {
		const path = join(this.store.directory, 'operations.json');
		await writeFile(`${path}.tmp`, JSON.stringify(operations), { mode: 0o600 });
		await rename(`${path}.tmp`, path);
	}
}
