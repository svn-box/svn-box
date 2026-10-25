import type { SvnboxApi } from '../../shared/types';
declare global {
	interface Window {
		svnbox: SvnboxApi;
	}
}
