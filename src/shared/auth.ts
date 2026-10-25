import type { CredentialProfile } from './types';

export function svnAddress(value: string): URL {
	const url = new URL(value);
	if (!['file:', 'https:', 'http:', 'svn:', 'svn+ssh:'].includes(url.protocol) || url.password || url.search || url.hash || /[\r\n\0]/.test(decodeURIComponent(url.username))) {
		throw new Error('请输入有效的 SVN 地址；地址可以包含用户名，但不能包含密码、查询参数或片段');
	}
	return url;
}

export function credentialRoot(value: string): string {
	const url = svnAddress(value);
	url.username = '';
	url.hostname = url.hostname.toLowerCase();
	if (url.protocol === 'svn:' && url.port === '3690') {
		url.port = '';
	}
	return url.href.replace(/\/$/, '');
}

export function connectionRoot(value: string): string {
	const url = svnAddress(value);
	if (url.protocol !== 'file:') {
		url.pathname = '/';
	}
	return credentialRoot(url.href);
}

export function withinCredentialRoot(root: string, target: string): boolean {
	const parent = credentialRoot(root);
	const child = credentialRoot(target);
	return parent === child || child.startsWith(`${parent}/`);
}

export function findCredential(profiles: CredentialProfile[], target: string, preferredId?: string): CredentialProfile | undefined {
	const username = decodeURIComponent(svnAddress(target).username);
	const matches = profiles.filter((profile) => profile.rootUrl && withinCredentialRoot(profile.rootUrl, target) && (!username || username === profile.username));
	const longest = Math.max(...matches.map((profile) => profile.rootUrl!.length));
	const closest = matches.filter((profile) => profile.rootUrl!.length === longest);
	return closest.find((profile) => profile.id === preferredId) ?? (closest.length === 1 ? closest[0] : undefined);
}
