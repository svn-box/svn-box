import { expect, it, vi } from 'vitest';
it('后台解析文本与属性变更段，并排时对齐增删行', async () => {
	const messages: { rows: { type: string; oldLine?: number; newLine?: number; old: string; next: string }[] }[] = [];
	const scope = { onmessage: undefined as undefined | ((event: unknown) => void), postMessage: (message: any) => messages.push(message) };
	vi.stubGlobal('self', scope);
	try {
		await import('../src/renderer/src/diff.worker');
		scope.onmessage!({ data: { id: 1, split: false, text: '@@ -10 +10 @@\n-old\n+new\nProperty changes on: file\n## -0,0 +1 ##\n+property value' } });
		expect(messages[0].rows.filter((row) => row.type === 'hunk')).toHaveLength(2);
		expect(messages[0].rows.at(-1)?.newLine).toBe(1);
		scope.onmessage!({ data: { id: 2, split: true, text: '@@ -1,2 +1,2 @@\n-old\n+new\n context' } });
		expect(messages[1].rows[1]).toMatchObject({ type: 'pair', old: 'old', next: 'new', oldLine: 1, newLine: 1 });
	} finally {
		vi.unstubAllGlobals();
	}
});
