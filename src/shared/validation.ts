import { translate, UI_LANGUAGES } from './i18n';
import { z } from 'zod';
import { themeIds } from './themes';
const text = z
	.string()
	.max(32768)
	.refine((s) => !s.includes('\0'), { error: () => translate('validation.nullCharactersAreNotAllowed') });
const id = z.string().min(1).max(200);
export const requestOptionsSchema = z.object({ requestId: id.optional() }).strict();
const path = text.refine((s) => !/[\r\n]/.test(s), { error: () => translate('validation.pathsCannotContainLineBreaks') });
const wc = z.object({ wcId: id });
const paths = z.array(path).max(2000);
export const schemas = {
	appUpdate: z.object({ action: z.enum(['status', 'check', 'download', 'install', 'release']) }).strict(),
	state: z.undefined(),
	detect: z.object({ path: path.optional() }),
	settings: z
		.object({
			svnPath: path.optional(),
			theme: z.enum(themeIds).optional(),
			mergeTool: path.optional(),
			language: z.enum(UI_LANGUAGES).optional(),
		})
		.strict(),
	pickFolder: z.undefined(),
	addWorkingCopy: z.object({ path, name: text.optional() }),
	addRepository: z.object({ url: text, name: text.optional(), credentialId: id.optional() }),
	bookmark: z.object({ repositoryId: id, url: text, name: text, id: id.optional(), remove: z.boolean().optional(), direction: z.enum(['up', 'down']).optional() }),
	compare: wc.extend({ path, revision: z.number().int().positive().optional() }),
	manage: z.object({
		entity: z.enum(['workingCopy', 'repository', 'group']),
		id: id.optional(),
		name: text.optional(),
		remove: z.boolean().optional(),
		favorite: z.boolean().optional(),
		groupId: text.optional(),
		direction: z.enum(['up', 'down']).optional(),
		credentialId: text.optional(),
	}),
	session: wc.extend({
		patch: z
			.object({
				draft: text.max(100000),
				selected: paths,
				filter: z.enum(['all', 'modified', 'added', 'deleted', 'unversioned', 'ignored', 'conflicted']),
				fileSearch: text.optional(),
				expanded: paths,
				currentPath: path,
				view: z.enum(['changes', 'files', 'history']),
				lastFileView: z.enum(['changes', 'files']).optional(),
				treeInitialized: z.boolean().optional(),
				historyDiffPath: path.optional(),
				historyTarget: path,
				historyRevision: z.number().int().positive().optional(),
				historySearch: text.optional(),
				historyCollapsedDates: z.array(z.string().max(32)).max(10000).optional(),
				historyCollapsedRevisions: z.array(z.number().int().positive()).max(10000).optional(),
				historyPreviewOpen: z.boolean().optional(),
			})
			.partial()
			.strict(),
	}),
	activate: wc,
	status: wc.extend({ remote: z.boolean().optional() }),
	info: wc.extend({ path }),
	properties: wc.extend({ path }),
	diff: wc.extend({ path, revision: z.number().int().positive().optional() }),
	log: wc.extend({ path: path.optional(), before: z.number().int().nonnegative().optional() }),
	list: z.object({ url: text, repositoryId: id.optional() }),
	checkout: z.object({ url: text, destination: path, repositoryId: id.optional(), depth: z.enum(['infinity', 'immediates', 'files', 'empty']) }),
	review: wc.extend({
		action: z.enum(['commit', 'update', 'add', 'rename', 'delete', 'ignore', 'revert', 'resolve', 'cleanup']),
		paths,
		destination: path.optional(),
		message: text.max(100000).optional(),
	}),
	execute: z.object({ reviewId: id }),
	operations: z.undefined(),
	copyOperation: z.object({ id }).strict(),
	clearOperations: z.object({ ids: z.array(id).max(1000) }).strict(),
	cancel: z.object({ id }),
	cancelRequest: z.object({ id }),
	authentication: z
		.object({ url: text.optional(), repositoryId: id.optional(), wcId: id.optional(), reviewId: id.optional() })
		.refine((value) => [value.url, value.wcId, value.reviewId].filter(Boolean).length === 1, { error: () => translate('validation.specifyExactlyOneAuthenticationTarget') }),
	credential: z.object({ rootUrl: text, url: text.optional(), name: text.optional(), username: path, password: path, id: id.optional(), remove: z.boolean().optional() }),
	credentialForEdit: z.object({ id, rootUrl: text, url: text }).strict(),
	system: wc.extend({ path, action: z.enum(['reveal', 'copy', 'terminal', 'merge']) }),
};
