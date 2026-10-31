export const appUpdateRepository = { provider: 'github', owner: 'svn-box', repo: 'svn-box' } as const;
export const appReleasesUrl = `https://github.com/${appUpdateRepository.owner}/${appUpdateRepository.repo}/releases`;

export type AppUpdateAction = 'status' | 'check' | 'download' | 'cancel' | 'install' | 'release';
export type AppUpdateMessageKey =
	'updates.developmentDisabled' | 'updates.platformDisabled' | 'updates.busy' | 'updates.installFailed' | 'updates.downloadFailed' | 'updates.checkFailed';

export interface AppUpdateState {
	phase: 'disabled' | 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'verifying' | 'paused' | 'downloaded' | 'installing' | 'error';
	currentVersion: string;
	revision: number;
	version?: string;
	publishedAt?: number;
	percent?: number;
	received?: number;
	total?: number;
	notes?: string;
	message?: string;
	messageKey?: AppUpdateMessageKey;
}
