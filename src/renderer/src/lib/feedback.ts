import { toast } from 'sonner';
import type { AppError, Operation } from '../../../shared/types';
import { errorText } from './api';
import { requestAuthentication } from './authentication';

export function notifyError(error: unknown): void {
	const value = error as Partial<AppError>;
	if (value?.kind === 'cancelled') {
		return;
	}
	const message = value?.message || '操作未完成';
	const detail = (value?.detail || errorText(error)).split('\n').find((line) => line.trim() && line !== message);
	toast.error(message, { description: detail?.slice(0, 220), duration: 7000 });
}

export function notifyOperation(operation: Operation, project: string, openRecords: () => void): void {
	const options = { id: `operation-${operation.id}`, description: project, action: { label: '查看记录', onClick: openRecords } };
	if (operation.state === 'waiting' || operation.state === 'running') {
		toast.loading(operation.state === 'waiting' ? `${operation.label} · 等待中` : `${operation.label}…`, options);
	} else if (operation.state === 'success') {
		const conflicts = operation.logs.some((line) => line.includes('个路径存在冲突'));
		if (conflicts) {
			toast.warning('更新完成，有冲突需要处理', { ...options, duration: 8000 });
		} else {
			toast.success(`${operation.label}完成`, { ...options, duration: 4500 });
		}
	} else if (operation.state === 'uncertain') {
		toast.warning('提交结果待核实', { ...options, description: `${project} · 请先检查仓库历史，再决定是否重试`, duration: Infinity });
	} else if (operation.state === 'cancelled') {
		toast.info('操作已取消', { ...options, description: `${project} · 已完成的修改不会回滚`, duration: 6000 });
	} else {
		toast.error(operation.error?.message || `${operation.label}失败`, {
			...options,
			duration: 8000,
			action: operation.error?.auth
				? {
						label: '连接认证',
						onClick: () => {
							void requestAuthentication(operation.error!.auth!)
								.then(() => toast.info('认证已更新，请核对后重新执行操作'))
								.catch(notifyError);
						},
					}
				: options.action,
		});
	}
}
