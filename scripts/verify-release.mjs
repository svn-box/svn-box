import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readReleaseMetadata, verifyReleaseFiles } from './release-metadata.mjs';
import { releaseCommand, verifySignature, verifySignedDmg } from './release-signing.mjs';
import { verifyApplication } from './verify-package.mjs';
import { verifyNativeRuntime } from './native-runtime-signing.mjs';

const unsigned = process.argv.length === 3 && process.argv[2] === '--unsigned';
assert.ok(process.argv.length === 2 || unsigned);
const metadata = await readReleaseMetadata(resolve('.'), { unsigned, tag: process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined });
const manifest = await verifyReleaseFiles(metadata);
const temporary = await mkdtemp(join(tmpdir(), 'svnbox-verify-'));
const mount = join(temporary, 'mounted');
await mkdir(mount);
let mounted = false;
try {
	const archive = join(metadata.directory, metadata.archives[1]);
	const entries = (await releaseCommand('/usr/bin/tar', ['-tzf', archive])).stdout.trim().split('\n');
	assert.ok(
		entries.length > 5 && entries.every((name) => (name === '仓盒.app/' || name.startsWith('仓盒.app/')) && !name.split('/').includes('..') && !name.includes('/._')),
		'Invalid updater archive structure.',
	);
	await releaseCommand('/usr/bin/tar', ['-xzf', archive, '-C', temporary]);
	const application = join(temporary, '仓盒.app');
	const digest = await verifyApplication(application);
	if (!unsigned) {
		assert.equal(manifest.teamId, process.env.APPLE_TEAM_ID, 'Apple team differs from the configured release team.');
		await verifySignature(application, manifest.teamId, true);
		await verifyNativeRuntime(join(application, 'Contents/Resources/svn'), manifest.teamId);
		await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', application]);
		await releaseCommand('/usr/sbin/spctl', ['--assess', '--type', 'execute', application]);
	}
	const installer = join(metadata.directory, metadata.archives[0]);
	await releaseCommand('/usr/bin/hdiutil', ['verify', installer]);
	if (!unsigned) {
		await verifySignedDmg(installer, manifest.teamId);
	}
	await releaseCommand('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, installer]);
	mounted = true;
	const mountedApp = join(mount, '仓盒.app');
	assert.equal(await verifyApplication(mountedApp), digest, 'DMG and updater archive differ.');
	if (!unsigned) {
		await verifySignature(mountedApp, manifest.teamId, true);
		await verifyNativeRuntime(join(mountedApp, 'Contents/Resources/svn'), manifest.teamId);
		await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', mountedApp]);
	}
	console.log(
		`PASS: ${metadata.tag}, extracted updater + mounted DMG, native resources, notices, signatures, signed version and checksums${unsigned ? ' (local ad-hoc preview)' : ', Apple notarization and Gatekeeper'}.`,
	);
} finally {
	if (mounted) {
		await releaseCommand('/usr/bin/hdiutil', ['detach', mount]);
	}
	await rm(temporary, { recursive: true, force: true });
}
