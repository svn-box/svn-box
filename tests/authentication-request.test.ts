import { afterEach, expect, it } from 'vitest';
import { currentAuthentication, finishAuthentication, requestAuthentication } from '../src/renderer/src/lib/authentication';
import type { AuthenticationContext } from '../src/shared/types';

const context: AuthenticationContext = { url: 'svn://server/repo', rootUrl: 'svn://server', username: 'tester', credentialId: 'profile' };

afterEach(() => {
	while (currentAuthentication()) {
		finishAuthentication(currentAuthentication()!.id, true);
	}
});

it('同一用途的连接认证请求复用一张表单', async () => {
	const first = requestAuthentication(context);
	const second = requestAuthentication(context);
	void first.catch(() => {});
	void second.catch(() => {});
	finishAuthentication(currentAuthentication()!.id);
	expect(await Promise.all([first, second])).toEqual(['saved', 'saved']);
	expect(currentAuthentication()).toBeUndefined();
});

it('保存编辑表单不会完成排队中的连接认证或恢复其操作', async () => {
	const edit = requestAuthentication(context, undefined, 'edit');
	const connection = requestAuthentication(context);
	void edit.catch(() => {});
	void connection.catch(() => {});
	expect(currentAuthentication()?.intent).toBe('edit');
	const editId = currentAuthentication()!.id;
	finishAuthentication(editId);
	expect(await edit).toBe('saved');
	expect(currentAuthentication()?.intent).toBe('connect');
	expect(currentAuthentication()?.id).not.toBe(editId);
	finishAuthentication(currentAuthentication()!.id, true);
	await expect(connection).rejects.toMatchObject({ kind: 'cancelled' });
});
