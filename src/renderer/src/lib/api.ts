import { isCancellableRpc, type AppError, type RpcMap, type RpcName } from '../../../shared/types';
import { requestAuthentication } from './authentication';

interface ClientOptions {
	signal?: AbortSignal;
	useExistingAuthentication?: boolean;
}

const existingConnections = new Set<string>();
const cancelled = () => ({ kind: 'cancelled', message: '连接已停止' });

function checkSignal(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw cancelled();
	}
}

function authenticationTarget<K extends RpcName>(method: K, input: RpcMap[K]['input']): RpcMap['authentication']['input'] | undefined {
	const target = input as { url?: string; repositoryId?: string; wcId?: string; revision?: number; remote?: boolean; reviewId?: string } | undefined;
	if (!target) {
		return;
	}
	if (['list', 'addRepository', 'checkout'].includes(method) && target.url) {
		return { url: target.url, repositoryId: target.repositoryId };
	}
	if ((method === 'log' || (['diff', 'compare'].includes(method) && target.revision !== undefined) || (method === 'status' && target.remote)) && target.wcId) {
		return { wcId: target.wcId };
	}
	if (method === 'execute' && target.reviewId) {
		return { reviewId: target.reviewId };
	}
}

function invoke<K extends RpcName>(method: K, input: RpcMap[K]['input'], signal?: AbortSignal): Promise<RpcMap[K]['output']> {
	checkSignal(signal);
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const abort = () => {
			void window.svnbox.call('cancelRequest', { id: requestId }).catch(() => {});
			reject(cancelled());
		};
		signal?.addEventListener('abort', abort, { once: true });
		window.svnbox
			.call(method, input, { requestId })
			.then(resolve, reject)
			.finally(() => signal?.removeEventListener('abort', abort));
		if (signal?.aborted) {
			abort();
		}
	});
}

export const api = {
	...window.svnbox,
	async call<K extends RpcName>(method: K, input: RpcMap[K]['input'], options: ClientOptions = {}): Promise<RpcMap[K]['output']> {
		if (options.signal && !isCancellableRpc(method)) {
			throw { kind: 'validation', message: '此操作使用操作记录中的取消入口' };
		}
		checkSignal(options.signal);
		const target = authenticationTarget(method, input);
		if (target && !options.useExistingAuthentication) {
			const context = await window.svnbox.call('authentication', target);
			checkSignal(options.signal);
			const key = context ? `${context.rootUrl}\0${context.username}` : '';
			if (context && !context.credentialId && !existingConnections.has(key)) {
				const choice = await requestAuthentication(context, options.signal);
				if (choice === 'existing') {
					existingConnections.add(key);
				}
			}
		}
		for (let attempt = 0; ; attempt++) {
			checkSignal(options.signal);
			try {
				return await invoke(method, input, options.signal);
			} catch (error) {
				const value = error as AppError;
				if (attempt >= 2 || value.kind !== 'auth' || !value.auth?.retrySafe) {
					throw error;
				}
				existingConnections.delete(`${value.auth.rootUrl}\0${value.auth.username}`);
				const choice = await requestAuthentication(value.auth, options.signal);
				if (choice === 'existing') {
					existingConnections.add(`${value.auth.rootUrl}\0${value.auth.username}`);
				}
			}
		}
	},
};

export function errorText(error: unknown): string {
	const value = error as { message?: string; detail?: string };
	return [value?.message || String(error), value?.detail].filter(Boolean).join('\n');
}
