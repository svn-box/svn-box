import { translate } from '../../../shared/i18n';
import type { AuthenticationContext } from '../../../shared/types';
export type AuthenticationChoice = 'saved' | 'existing';
export type AuthenticationIntent = 'connect' | 'edit';
interface AuthenticationRequest {
	id: string;
	context: AuthenticationContext;
	intent: AuthenticationIntent;
	promise: Promise<AuthenticationChoice>;
	resolve: (choice: AuthenticationChoice) => void;
	reject: (error: unknown) => void;
	consumers: number;
}
let requests: AuthenticationRequest[] = [];
const listeners = new Set<() => void>();

const cancelled = () => ({
	kind: 'cancelled',
	message: translate('authentication.connectionAuthenticationCancelled'),
});

export function requestAuthentication(context: AuthenticationContext | null, signal?: AbortSignal, intent: AuthenticationIntent = 'connect'): Promise<AuthenticationChoice> {
	if (signal?.aborted) {
		return Promise.reject(cancelled());
	}
	if (!context) {
		return Promise.resolve('saved');
	}
	let request = requests.find(
		(request) =>
			request.intent === intent &&
			request.context.rootUrl === context.rootUrl &&
			request.context.username === context.username &&
			request.context.credentialId === context.credentialId,
	);
	if (!request) {
		let resolve!: (choice: AuthenticationChoice) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<AuthenticationChoice>((onResolve, onReject) => {
			resolve = onResolve;
			reject = onReject;
		});
		request = { id: crypto.randomUUID(), context, intent, promise, resolve, reject, consumers: 0 };
		requests = [...requests, request];
		listeners.forEach((listener) => listener());
	}
	const active = request;
	active.consumers++;
	return new Promise((resolve, reject) => {
		let settled = false;

		const release = () => {
			settled = true;
			signal?.removeEventListener('abort', abort);
			active.consumers--;
		};

		const abort = () => {
			if (settled) {
				return;
			}
			release();
			reject(cancelled());
			if (!active.consumers && requests.includes(active)) {
				requests = requests.filter((request) => request !== active);
				listeners.forEach((listener) => listener());
				active.reject(cancelled());
			}
		};

		signal?.addEventListener('abort', abort, { once: true });
		active.promise.then(
			(choice) => {
				if (!settled) {
					release();
					resolve(choice);
				}
			},
			(error) => {
				if (!settled) {
					release();
					reject(error);
				}
			},
		);
		if (signal?.aborted) {
			abort();
		}
	});
}

export function subscribeAuthentication(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function currentAuthentication(): AuthenticationRequest | undefined {
	return requests[0];
}

export function finishAuthentication(id: string, isCancelled = false, choice: AuthenticationChoice = 'saved'): void {
	const request = requests.find((request) => request.id === id);
	requests = requests.filter((request) => request.id !== id);
	listeners.forEach((listener) => listener());
	if (isCancelled) {
		request?.reject(cancelled());
	} else {
		request?.resolve(choice);
	}
}
