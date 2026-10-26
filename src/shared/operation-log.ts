import { translate, UI_RESOURCES } from './i18n';
import type { Operation } from './types';

const actions = ['commit', 'update', 'add', 'rename', 'delete', 'ignore', 'revert', 'resolve', 'cleanup', 'checkout'] as const;
const legacyRevertLabels = new Set(['还原变更', 'Revert Local Changes']);

export function operationAction(operation: Pick<Operation, 'action' | 'label'>): Operation['action'] {
	return (
		operation.action ??
		(legacyRevertLabels.has(operation.label)
			? 'revert'
			: actions.find((action) => Object.values(UI_RESOURCES).some((resource) => resource.translation.operations[action] === operation.label)))
	);
}

export function operationLabel(operation: Pick<Operation, 'action' | 'label'>): string {
	const action = operationAction(operation);
	return action ? translate(`operations.${action}`) : operation.label;
}

export function operationHasConflicts(operation: Operation): boolean {
	return (
		operation.state === 'success' &&
		(operation.conflictCount !== undefined
			? operation.conflictCount > 0
			: operation.logs.some((line) => /个路径存在冲突|Update finished with \d+ conflicted paths/i.test(line)))
	);
}

export function operationOutput(operation: Operation): string {
	const output = operation.logs.join('').replace(/\r\n?/g, '\n');
	const detail = operation.error?.detail?.replace(/\r\n?/g, '\n').trim();
	if (!output.trim()) {
		return detail ?? '';
	}
	const existing = new Set(output.split('\n').map((line) => line.trimEnd()));
	const missing = detail?.split('\n').filter((line) => line.trim() && !existing.has(line.trimEnd())) ?? [];
	return missing.length ? `${output.trimEnd()}\n${missing.join('\n')}` : output;
}

export const operationLabels: Record<Operation['state'], string> = {
	get waiting() {
		return translate('operations.waiting');
	},

	get running() {
		return translate('operations.running');
	},

	get success() {
		return translate('operations.success');
	},

	get failed() {
		return translate('operations.failed');
	},

	get cancelled() {
		return translate('operations.cancelled');
	},

	get uncertain() {
		return translate('operations.uncertain');
	},
};
