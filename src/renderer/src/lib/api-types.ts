import type { RpcMap, RpcName } from '../../../shared/types';

export interface ClientOptions {
	signal?: AbortSignal;
	useExistingAuthentication?: boolean;
}

export type ClientCall = <K extends RpcName>(method: K, input: RpcMap[K]['input'], options?: ClientOptions) => Promise<RpcMap[K]['output']>;
