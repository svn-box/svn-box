export const appUpdateRepository = { provider: 'github', owner: 'svn-box', repo: 'svn-box' } as const;
export const appReleasesUrl = `https://github.com/${appUpdateRepository.owner}/${appUpdateRepository.repo}/releases`;

export type AppUpdateAction = 'status' | 'check' | 'download' | 'install' | 'release';

export interface AppUpdateState {
	phase: 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
	currentVersion: string;
	revision: number;
	version?: string;
	percent?: number;
	message?: string;
}
