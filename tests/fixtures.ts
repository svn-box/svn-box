import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/main/store';
import { Runner } from '../src/main/runner';
import { SvnService } from '../src/main/service';

const exec = promisify(execFile);
export const svn = async (...args: string[]) => (await exec('/opt/homebrew/bin/svn', args, { env: { ...process.env, LC_ALL: 'en_US.UTF-8' } })).stdout;
export async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'svnbox-test-')));
	const repository = join(root, '仓库 @ repository');
	await exec('/opt/homebrew/bin/svnadmin', ['create', repository]);
	const url = pathToFileURL(repository).href;
	await svn('mkdir', `${url}/trunk@`, '-m', '创建主干');
	const a = join(root, '工作副本 A @');
	const b = join(root, '工作副本 B');
	await svn('checkout', `${url}/trunk@`, a);
	await mkdir(join(a, '目录 空格'));
	await writeFile(join(a, '目录 空格', '中文 @ 文件.txt'), '第一行\n共享的内容\n第三行\n');
	await writeFile(join(a, 'README.md'), '# 仓盒测试\n\n初始版本。\n');
	await writeFile(join(a, 'other.txt'), 'untouched\n');
	await svn('add', `${a}/目录 空格@`, `${a}/README.md@`, `${a}/other.txt@`);
	await svn('propset', 'svn:mime-type', 'text/plain', `${a}/目录 空格/中文 @ 文件.txt@`);
	await svn('commit', `${a}@`, '-m', '初始文件');
	await svn('checkout', `${url}/trunk@`, b);
	const runner = new Runner();
	const store = new Store(join(root, 'app-data'));
	const service = new SvnService(store, runner);
	await service.initialize();
	await service.addWorkingCopy(a);
	await service.addWorkingCopy(b);
	const [first, second] = store.get().workingCopies;
	return { root, repository, url, a, b, runner, store, service, first, second };
}

export async function finish(service: SvnService, operation: { id: string }) {
	const start = Date.now();
	while (Date.now() - start < 20000) {
		const current = service.getOperations().find((item) => item.id === operation.id)!;
		if (!['waiting', 'running'].includes(current.state)) {
			return current;
		}
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
	throw new Error('操作未在 20 秒内结束');
}
