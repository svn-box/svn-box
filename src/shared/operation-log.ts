import type { Operation } from './types';

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
	waiting: '等待中',
	running: '执行中',
	success: '已完成',
	failed: '失败',
	cancelled: '已取消',
	uncertain: '结果待核实',
};
