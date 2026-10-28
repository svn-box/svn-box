import { describe, expect, it } from 'vitest';
import { nativeInput } from '../src/renderer/src/desktop/transport';
import { schemas } from '../src/shared/validation';

describe('Tauri JSON transport', () => {
	it('preserves explicit optional field resets across JSON serialization', () => {
		const value = schemas.session.parse({ wcId: 'copy', patch: { historyRevision: undefined, historyDiffPath: undefined, historyPreviewOpen: false, draft: '' } });
		expect(JSON.parse(JSON.stringify(nativeInput('session', value)))).toEqual({
			wcId: 'copy',
			patch: { historyRevision: null, historyDiffPath: null, historyPreviewOpen: false, draft: '' },
		});
	});

	it('preserves zero revisions and uses null for commands without arguments', () => {
		expect(nativeInput('state', undefined)).toBeNull();
		expect(nativeInput('rangeDiff', { wcId: 'copy', path: 'README.md', from: 0, to: 'WORKING' })).toEqual({ wcId: 'copy', path: 'README.md', from: 0, to: 'WORKING' });
	});
});
