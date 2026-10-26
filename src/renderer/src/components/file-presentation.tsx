import { formatDateTime } from '../../../shared/i18n/format';
import { useTranslation } from 'react-i18next';
import { translate } from '../../../shared/i18n';
import { isConflict, type FileStatus, type Filter } from '../../../shared/types';
export const statusLabels: Record<string, string> = {
	get normal() {
		return translate('filePresentation.normal');
	},

	get modified() {
		return translate('common.modified');
	},

	get added() {
		return translate('common.added');
	},

	get deleted() {
		return translate('common.deleted');
	},

	get missing() {
		return translate('filePresentation.missing');
	},

	get unversioned() {
		return translate('filePresentation.unversioned');
	},

	get ignored() {
		return translate('filePresentation.ignored');
	},

	get conflicted() {
		return translate('filePresentation.conflicted');
	},

	get replaced() {
		return translate('common.replaced');
	},

	get external() {
		return translate('filePresentation.externalWorkingCopy');
	},

	get obstructed() {
		return translate('filePresentation.obstructed');
	},

	get incomplete() {
		return translate('filePresentation.incomplete');
	},

	none: '—',
};
export const statusCodes: Record<string, string> = {
	normal: '✓',
	modified: 'M',
	added: 'A',
	deleted: 'D',
	missing: '!',
	unversioned: '?',
	ignored: 'I',
	conflicted: 'C',
	replaced: 'R',
	external: 'X',
	obstructed: '~',
	incomplete: '!',
};
export const filters: { value: Filter; label: string }[] = [
	{
		value: 'all',

		get label() {
			return translate('filePresentation.all');
		},
	},
	{
		value: 'modified',

		get label() {
			return translate('common.modified');
		},
	},
	{
		value: 'added',

		get label() {
			return translate('common.added');
		},
	},
	{
		value: 'deleted',

		get label() {
			return translate('common.deleted');
		},
	},
	{
		value: 'unversioned',

		get label() {
			return translate('filePresentation.unversioned');
		},
	},
	{
		value: 'ignored',

		get label() {
			return translate('filePresentation.ignored');
		},
	},
	{
		value: 'conflicted',

		get label() {
			return translate('filePresentation.conflicted');
		},
	},
];
export { operationLabels as opLabels } from '../../../shared/operation-log';

export const fmtDate = (date?: string): string =>
	date
		? formatDateTime(date, {
				hour12: false,
			})
		: '—';

export const leaf = (path: string): string => path.split('/').at(-1) || path;

export const parent = (path: string): string => (path.includes('/') ? path.split('/').slice(0, -1).join('/') : '');

export function fileState(file: FileStatus): string {
	return isConflict(file)
		? 'conflicted'
		: file.copied && ['normal', 'none'].includes(file.item)
			? 'added'
			: file.props === 'modified' && ['normal', 'none'].includes(file.item)
				? 'modified'
				: file.item;
}

export function StatusBadge({ file }: { file: FileStatus }) {
	const { t } = useTranslation();
	const status = fileState(file);
	return (
		<span
			className={`status-badge ${status}`}
			title={t('filePresentation.properties', {
				value: statusLabels[status] || status,
				value2: statusLabels[file.props] || file.props,
				value3: file.copied ? t('filePresentation.copiedWithHistory') : '',
				value4: file.treeConflicted ? t('filePresentation.treeConflict') : '',
			})}
		>
			<b>{statusCodes[status] || '·'}</b>
			{statusLabels[status] || status}
			{file.props === 'modified' && <i>{t('filePresentation.properties2')}</i>}
			{file.copied && <i>{t('common.copy')}</i>}
			{file.treeConflicted && <i>{t('filePresentation.tree')}</i>}
			{file.external && <i>{t('filePresentation.external')}</i>}
		</span>
	);
}
