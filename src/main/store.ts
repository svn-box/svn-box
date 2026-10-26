import { normalizeUiLanguage, translate, UI_LANGUAGE } from '../shared/i18n';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppState } from '../shared/types';
import { normalizeTheme } from '../shared/themes';
import { credentialRoot } from '../shared/auth';
export class Store {
	private data: AppState = {
		version: 1,
		repositories: [],
		workingCopies: [],
		bookmarks: [],
		groups: [],
		sessions: {},
		credentials: [],
		recentMessages: [],
		settings: {
			svnPath: '',
			theme: 'light',
			mergeTool: '',
			language: UI_LANGUAGE,
		},
	};
	private tail: Promise<void> = Promise.resolve();
	readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
	}

	async load(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		try {
			const data = JSON.parse(await readFile(join(this.directory, 'workspace.json'), 'utf8'));
			if (data.version !== 1 || !Array.isArray(data.workingCopies) || !data.sessions || !data.settings) {
				throw new Error(translate('store.unsupportedDataFormatPreserveWorkspaceJsonBeforeInvestigating'));
			}
			this.data = {
				...data,
				bookmarks: data.bookmarks ?? [],
				settings: {
					...data.settings,
					theme: normalizeTheme(data.settings.theme),
					language: normalizeUiLanguage(data.settings.language),
				},
			};
			for (const profile of this.data.credentials) {
				const repository = this.data.repositories.find((repo) => repo.credentialId === profile.id);
				if (!profile.rootUrl && repository) {
					profile.rootUrl = credentialRoot(repository.rootUrl);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}

	get(): AppState {
		return structuredClone(this.data);
	}

	async flush(): Promise<void> {
		await this.tail;
	}

	async change(mutator: (state: AppState) => void): Promise<AppState> {
		const next = this.tail.then(async () => {
			const copy = structuredClone(this.data);
			mutator(copy);
			const temp = join(this.directory, 'workspace.json.tmp');
			await writeFile(temp, JSON.stringify(copy, null, 2), { mode: 0o600 });
			await chmod(temp, 0o600);
			await rename(temp, join(this.directory, 'workspace.json'));
			this.data = copy;
		});
		this.tail = next.catch(() => {});
		await next;
		return this.get();
	}
}
