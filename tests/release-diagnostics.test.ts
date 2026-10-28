import { describe, expect, it } from 'vitest';
// @ts-expect-error Release scripts run directly in Node.js.
import { releaseCommand } from '../scripts/release-signing.mjs';

describe('release command diagnostics', () => {
	it('retains the signing failure while redacting credentials from both output streams', async () => {
		const env = {
			...process.env,
			APPLE_PASSWORD: 'fixture-notary-password',
			TAURI_SIGNING_PRIVATE_KEY: 'fixture-private-key\nsecond-private-line',
		};
		const script = [
			"console.error('The binary is not signed with a valid Developer ID certificate.');",
			'console.error(process.env.APPLE_PASSWORD);',
			'console.log(JSON.stringify(process.env.TAURI_SIGNING_PRIVATE_KEY));',
			'process.exit(42);',
		].join('\n');
		const error = await releaseCommand(process.execPath, ['-e', script], env).catch((error: Error) => error);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain('valid Developer ID certificate');
		expect(error.message).toContain('42');
		expect(error.message).toContain('<REDACTED>');
		expect(error.message).not.toContain(env.APPLE_PASSWORD);
		expect(error.message).not.toContain('fixture-private-key');
		expect(error.message).not.toContain('second-private-line');
	});
});
