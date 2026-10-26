import { translate } from '../../../shared/i18n';
import { isOperationActive, type Operation } from '../../../shared/types';
export { operationOutput } from '../../../shared/operation-log';

export function operationDuration(operation: Operation, now = Date.now()): string {
	if (!operation.endedAt && !isOperationActive(operation)) {
		return '—';
	}
	const start = Date.parse(operation.startedAt);
	const end = operation.endedAt ? Date.parse(operation.endedAt) : now;
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
		return '—';
	}
	const seconds = (end - start) / 1000;
	if (seconds < 1) {
		return translate('operationLog.s', {
			value: seconds.toFixed(1),
		});
	}
	if (seconds < 60) {
		return translate('operationLog.s', {
			value: Math.floor(seconds),
		});
	}
	return translate('operationLog.minS', {
		value: Math.floor(seconds / 60),
		value2: Math.floor(seconds % 60),
	});
}

export { operationHasConflicts } from '../../../shared/operation-log';
