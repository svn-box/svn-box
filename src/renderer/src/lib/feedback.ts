import { operationLabel, operationHasConflicts } from '../../../shared/operation-log';
import { translate } from '../../../shared/i18n';
import { toast } from 'sonner';
import type { AppError, Operation } from '../../../shared/types';
import { errorText } from './api';
import { requestAuthentication } from './authentication';

export function notifyError(error: unknown, toastId?: string): void {
	const value = error as Partial<AppError>;
	if (value?.kind === 'cancelled') {
		if (toastId) {
			toast.info(translate('feedback.operationCancelled'), { id: toastId, duration: 4500 });
		}
		return;
	}
	const message = value?.message || translate('feedback.operationDidNotComplete');
	const detail = (value?.detail || errorText(error)).split('\n').find((line) => line.trim() && line !== message);
	toast.error(message, { id: toastId, description: detail?.slice(0, 220), duration: 7000 });
}

export function notifyOperation(operation: Operation, project: string, openRecords: () => void, toastId?: string): void {
	const options = {
		id: toastId ?? `operation-${operation.id}`,
		description: project,
		action: {
			label: translate('feedback.viewLog'),
			onClick: openRecords,
		},
	};
	if (operation.state === 'waiting' || operation.state === 'running') {
		toast.loading(
			operation.state === 'waiting'
				? translate('feedback.waiting', {
						label: operationLabel(operation),
					})
				: `${operationLabel(operation)}…`,
			options,
		);
	} else if (operation.state === 'success') {
		const conflicts = operationHasConflicts(operation);
		if (conflicts) {
			toast.warning(translate('feedback.updateFinishedWithConflictsToResolve'), { ...options, duration: 8000 });
		} else {
			toast.success(
				translate('feedback.completed', {
					label: operationLabel(operation),
				}),
				{ ...options, duration: 4500 },
			);
		}
	} else if (operation.state === 'uncertain') {
		toast.warning(translate('feedback.commitResultNeedsVerification'), {
			...options,
			description: translate('feedback.checkRepositoryHistoryBeforeDecidingWhetherToRetry', {
				project: project,
			}),
			duration: Infinity,
		});
	} else if (operation.state === 'cancelled') {
		toast.info(translate('feedback.operationCancelled'), {
			...options,
			description: translate('feedback.completedChangesWillNotBeUndone', {
				project: project,
			}),
			duration: 6000,
		});
	} else {
		toast.error(
			operation.error?.message ||
				translate('feedback.failed', {
					label: operationLabel(operation),
				}),
			{
				...options,
				duration: 8000,
				action: operation.error?.auth
					? {
							label: translate('authenticationHost.connectionCredentials'),
							onClick: () => {
								void requestAuthentication(operation.error!.auth!, undefined, 'edit')
									.then(() => toast.info(translate('feedback.credentialsUpdatedReviewTheScopeAndRunThe')))
									.catch(notifyError);
							},
						}
					: options.action,
			},
		);
	}
}
