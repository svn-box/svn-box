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
		return `${seconds.toFixed(1)} 秒`;
	}
	if (seconds < 60) {
		return `${Math.floor(seconds)} 秒`;
	}
	return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`;
}

export function operationHasConflicts(operation: Operation): boolean {
	return operation.state === 'success' && operation.logs.some((line) => line.includes('个路径存在冲突'));
}
