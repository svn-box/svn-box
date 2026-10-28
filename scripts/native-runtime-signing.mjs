import assert from 'node:assert/strict';
import { cp, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { releaseCommand, verifySignature } from './release-signing.mjs';

export async function stageSignedRuntime(source, destination, signing) {
	assert.ok(signing.identity.startsWith('Developer ID Application:'), 'The SVN runtime requires Developer ID signing.');
	await cp(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
	for (const path of await runtimeTargets(destination)) {
		await releaseCommand('/usr/bin/codesign', [
			'--force',
			'--sign',
			signing.identity,
			...(signing.keychain ? ['--keychain', signing.keychain] : []),
			'--timestamp',
			'--options',
			'runtime',
			path,
		]);
	}
	await verifyNativeRuntime(destination, signing.teamId);
	return destination;
}

export async function verifyNativeRuntime(root, teamId) {
	const targets = await runtimeTargets(root);
	for (const path of targets) {
		await verifySignature(path, teamId, true);
	}
	return targets.length;
}

async function runtimeTargets(root) {
	const entries = await readdir(join(root, 'lib'), { withFileTypes: true });
	const libraries = entries.filter((entry) => entry.name.endsWith('.dylib'));
	assert.ok(libraries.length > 0 && libraries.every((entry) => entry.isFile()), 'SVN libraries must be regular files.');
	const executable = join(root, 'bin/svn');
	assert.ok((await lstat(executable)).isFile(), 'The SVN executable must be a regular file.');
	return [...libraries.map((entry) => join(root, 'lib', entry.name)).sort(), executable];
}
