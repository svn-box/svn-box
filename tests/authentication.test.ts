import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/main/store';
import { Runner } from '../src/main/runner';
import { SvnService } from '../src/main/service';
import { connectionRoot, credentialRoot, findCredential, withinCredentialRoot } from '../src/shared/auth';

let directory: string;
let service: SvnService;
let server: ChildProcess;
let otherServer: ChildProcess;
let base: string;
let otherBase: string;
const secrets = new Map<string, string>();
const vault = {
	get: async (id: string) => secrets.get(id),
	set: async (id: string, password: string) => {
		secrets.set(id, password);
	},
	delete: async (id: string) => {
		secrets.delete(id);
	},
};

async function serve(root: string): Promise<{ process: ChildProcess; url: string }> {
	const port = await new Promise<number>((resolve) => {
		const socket = createServer();
		socket.listen(0, '127.0.0.1', () => {
			const address = socket.address();
			socket.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
		});
	});
	const process = spawn('/opt/homebrew/bin/svnserve', ['--daemon', '--foreground', '--listen-host', '127.0.0.1', '--listen-port', String(port), '--root', root], {
		stdio: 'ignore',
	});
	for (let attempt = 0; attempt < 60; attempt++) {
		const ready = await new Promise<boolean>((resolve) => {
			const socket = connect(port, '127.0.0.1');
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => resolve(false));
		});
		if (ready) {
			return { process, url: `svn://127.0.0.1:${port}` };
		}
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error('临时 svnserve 启动失败');
}

beforeAll(async () => {
	directory = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-auth-')));
	for (const name of ['one', 'two', 'isolated']) {
		const repository = join(directory, name);
		execFileSync('/opt/homebrew/bin/svnadmin', ['create', repository]);
		execFileSync('/opt/homebrew/bin/svn', ['mkdir', `${pathToFileURL(repository).href}/trunk`, '-m', '测试初始版本']);
		await writeFile(join(repository, 'conf/svnserve.conf'), '[general]\nanon-access = none\nauth-access = write\npassword-db = passwd\nrealm = svnbox-auth-scope\n');
		await writeFile(join(repository, 'conf/passwd'), `[users]\nshared = scope-secret-123\n${name === 'isolated' ? 'separate = isolated-secret-456\n' : ''}`);
	}
	const first = await serve(directory);
	server = first.process;
	base = first.url;
	const second = await serve(directory);
	otherServer = second.process;
	otherBase = second.url;
	service = new SvnService(new Store(join(directory, 'data')), new Runner(), () => {}, vault);
	await service.initialize();
}, 30000);

afterAll(async () => {
	service?.runner.shutdown();
	server?.kill();
	otherServer?.kill();
	if (directory) {
		await rm(directory, { recursive: true, force: true });
	}
});

it('按协议主机端口和路径边界匹配，显式用户名不会命中另一个账号', () => {
	expect(connectionRoot('svn://u_publish@example.com:3690/project')).toBe('svn://example.com');
	expect(credentialRoot('https://u@example.com/svn/root/')).toBe('https://example.com/svn/root');
	expect(withinCredentialRoot('svn://host/a', 'svn://host/ab')).toBe(false);
	expect(withinCredentialRoot('svn://host', 'svn://other/a')).toBe(false);
	expect(withinCredentialRoot('svn://host:3690', 'svn://host/a')).toBe(true);
	const profiles = [
		{ id: 'a', name: '', rootUrl: 'svn://host', username: 'alice' },
		{ id: 'b', name: '', rootUrl: 'svn://host', username: 'bob' },
	];
	expect(findCredential(profiles, 'svn://alice@host/project')?.id).toBe('a');
	expect(findCredential(profiles, 'svn://host/project')).toBeUndefined();
	expect(findCredential([...profiles, { id: 'c', name: '', rootUrl: 'svn://host/private', username: 'private' }], 'svn://host/private/project', 'a')?.id).toBe('c');
});

it('首次失败返回连接根与用户名；保存后不同 UUID 的子仓库共用一份认证', async () => {
	const target = base.replace('svn://', 'svn://shared@') + '/one/trunk';
	await expect(service.addRepository(target)).rejects.toMatchObject({ info: { kind: 'auth', auth: { rootUrl: base, username: 'shared', retrySafe: true } } });
	let state = await service.credential({ rootUrl: base, url: target, username: 'shared', password: 'scope-secret-123' });
	expect(state.credentials).toHaveLength(1);
	await service.addRepository(target, '第一个仓库');
	state = await service.addRepository(`${base}/two/trunk`, '第二个仓库');
	expect(new Set(state.repositories.map((repo) => repo.uuid)).size).toBe(2);
	expect(new Set(state.repositories.map((repo) => repo.credentialId)).size).toBe(1);
	expect(state.credentials).toHaveLength(1);
	expect(await service.list(`${base}/two`)).toHaveLength(1);
	expect(JSON.stringify(state)).not.toContain('scope-secret');
});

it('另一个端口不会收到已保存密码；本机保存与服务器认证分开', async () => {
	const spy = vi.spyOn(service.runner, 'run');
	await expect(service.list(`${otherBase}/one`)).rejects.toMatchObject({ info: { kind: 'auth', auth: { rootUrl: otherBase } } });
	expect(spy.mock.calls.at(-1)?.[1]?.password).toBeUndefined();
	spy.mockRestore();
	const profile = service.store.get().credentials[0];
	await service.credential({ id: profile.id, rootUrl: base, url: `${base}/one`, username: 'shared', password: 'wrong-secret' });
	expect(secrets.get(profile.id)).toBe('wrong-secret');
	await expect(service.list(`${base}/one`)).rejects.toMatchObject({ info: { kind: 'auth' } });
	await service.credential({ id: profile.id, rootUrl: base, url: `${base}/one`, username: 'shared', password: 'scope-secret-123' });
	expect(await service.list(`${base}/one`)).toHaveLength(1);
	await expect(service.credential({ id: profile.id, rootUrl: otherBase, username: 'shared', password: 'scope-secret-123' })).rejects.toThrow('不属于');
});

it('相同 UUID 经另一个连接检出的副本不会复用原地址密码', async () => {
	const destination = join(directory, 'other-port-working-copy');
	execFileSync(
		'/opt/homebrew/bin/svn',
		['checkout', '--non-interactive', '--no-auth-cache', '--username', 'shared', '--password-from-stdin', `${otherBase}/one/trunk`, destination],
		{ input: 'scope-secret-123\n' },
	);
	const state = await service.addWorkingCopy(destination);
	const copy = state.workingCopies.find((copy) => copy.path === destination)!;
	const spy = vi.spyOn(service.runner, 'run');
	await expect(service.log(copy.id)).rejects.toMatchObject({ info: { kind: 'auth' } });
	expect(spy.mock.calls.at(-1)?.[1]?.password).toBeUndefined();
	spy.mockRestore();
});

it('同一主机的独立路径可覆盖认证；重启恢复后继续正确选择', async () => {
	await writeFile(join(directory, 'isolated/conf/passwd'), '[users]\nseparate = isolated-secret-456\n');
	await expect(service.list(`${base}/isolated`)).rejects.toMatchObject({ info: { kind: 'auth' } });
	await service.credential({ rootUrl: `${base}/isolated`, url: `${base}/isolated`, username: 'separate', password: 'isolated-secret-456' });
	expect(await service.list(`${base}/isolated`)).toHaveLength(1);
	expect(await service.list(`${base}/two`)).toHaveLength(1);
	const restored = new SvnService(new Store(service.store.directory), new Runner(), () => {}, vault);
	await restored.initialize();
	expect(await restored.list(`${base}/isolated`)).toHaveLength(1);
	expect(await restored.list(`${base}/one`)).toHaveLength(1);
	restored.runner.shutdown();
	const profile = service.store.get().credentials.find((profile) => profile.rootUrl === `${base}/isolated`)!;
	await service.credential({ id: profile.id, rootUrl: profile.rootUrl!, username: '', password: '', remove: true });
	await expect(service.list(`${base}/isolated`)).rejects.toMatchObject({ info: { kind: 'auth' } });
});

it('旧版已关联认证按原仓库范围迁移，未关联全局密码不会被自动采用', async () => {
	const state = service.store.get();
	const profile = state.credentials[0];
	delete profile.rootUrl;
	state.credentials.push({ id: 'unused-global', name: '旧全局', username: 'unused' });
	const location = join(directory, 'migration');
	const store = new Store(location);
	await store.load();
	await writeFile(join(location, 'workspace.json'), JSON.stringify(state));
	await store.load();
	expect(store.get().credentials.find((item) => item.id === profile.id)?.rootUrl).toBe(credentialRoot(state.repositories[0].rootUrl));
	expect(findCredential(store.get().credentials, `${base}/unknown`)).toBeUndefined();
	expect(await readFile(join(location, 'workspace.json'), 'utf8')).not.toContain('scope-secret');
});
