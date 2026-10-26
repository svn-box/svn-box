export const appUpdateRepository = { provider: 'github', owner: 'svn-box', repo: 'svn-box' } as const;
export const appReleasesUrl = `https://github.com/${appUpdateRepository.owner}/${appUpdateRepository.repo}/releases`;

export type AppUpdateAction = 'status' | 'check' | 'download' | 'install' | 'release';
export type AppUpdateMessageKey =
	'updates.developmentDisabled' | 'updates.platformDisabled' | 'updates.busy' | 'updates.installFailed' | 'updates.downloadFailed' | 'updates.checkFailed';

export interface AppUpdateState {
	phase: 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
	currentVersion: string;
	revision: number;
	version?: string;
	percent?: number;
	message?: string;
	messageKey?: AppUpdateMessageKey;
}
