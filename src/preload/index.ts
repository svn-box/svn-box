import { contextBridge, ipcRenderer } from 'electron';
import type { SvnboxApi, RpcName, RpcMap, Reply, Operation, RequestOptions } from '../shared/types';

const api: SvnboxApi = {
	async call<K extends RpcName>(method: K, input: RpcMap[K]['input'], options?: RequestOptions): Promise<RpcMap[K]['output']> {
		const result: Reply<RpcMap[K]['output']> = await ipcRenderer.invoke('svnbox:call', method, input, options);
		if (!result.ok) {
			throw result.error;
		}
		return result.value;
	},
	onOperation(callback) {
		const listener = (_event: unknown, operation: Operation): void => callback(operation);
		ipcRenderer.on('svnbox:operation', listener);
		return () => ipcRenderer.removeListener('svnbox:operation', listener);
	},
	onNavigate(callback) {
		const listener = (_event: unknown, action: string): void => callback(action);
		ipcRenderer.on('svnbox:navigate', listener);
		return () => ipcRenderer.removeListener('svnbox:navigate', listener);
	},
};
contextBridge.exposeInMainWorld('svnbox', api);
