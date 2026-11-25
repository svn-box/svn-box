import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseEnv, promisify } from 'node:util';

const execute = promisify(execFile);

export async function localSigningSettings() {
	const path = join(homedir(), '.config/svnbox/release.env');
	let local = {};
	try {
		local = parseEnv(await readFile(path, 'utf8'));
	} catch (error) {
		if (error.code !== 'ENOENT') {
			throw error;
		}
	}
	const teamId = process.env.APPLE_TEAM_ID || local.APPLE_TEAM_ID;
	assert.match(teamId ?? '', /^[A-Z0-9]{10}$/, 'Set APPLE_TEAM_ID for the SVNBox signing team.');
	return {
		teamId,
		keychain: process.env.CSC_KEYCHAIN || local.CSC_KEYCHAIN,
		profile: process.env.SVNBOX_NOTARY_PROFILE || local.SVNBOX_NOTARY_PROFILE || 'svnbox-notary',
		notaryKeychain: process.env.SVNBOX_NOTARY_KEYCHAIN || local.SVNBOX_NOTARY_KEYCHAIN,
	};
}

export async function releaseCommand(tool, arguments_, env = process.env) {
	try {
		return await execute(tool, arguments_, { env, maxBuffer: 32 * 1024 * 1024, timeout: 45 * 60 * 1000 });
	} catch (error) {
		const values = [...Object.entries(process.env), ...Object.entries(env)]
			.filter(([name, value]) => value && /TOKEN|PASSWORD|SECRET|PRIVATE_KEY|CERTIFICATE|APPLE_ID|APPLE_TEAM_ID/i.test(name))
			.flatMap(([, value]) => [value, value.trim(), JSON.stringify(value).slice(1, -1)]);
		for (let index = 0; index < arguments_.length - 1; index++) {
			if (['--password', '--private-key', '--token'].includes(arguments_[index])) {
				values.push(arguments_[index + 1]);
			}
		}
		let output = [error.stdout, error.stderr].filter(Boolean).join('\n');
		for (const value of [...new Set(values)].filter(Boolean).sort((left, right) => right.length - left.length)) {
			output = output.replaceAll(value, '<REDACTED>');
		}
		const status = error.code ?? error.signal ?? 'unknown status';
		throw new Error(`${basename(tool)} failed (${status}).\n${output.slice(-10000).trim()}`);
	}
}

export async function prepareSigning() {
	const signing = await localSigningSettings();
	const { stdout } = await releaseCommand('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', ...(signing.keychain ? [signing.keychain] : [])]);
	const matches = new Map();
	for (const match of stdout.matchAll(/([A-F0-9]{40}) "([^"]+)"/g)) {
		if (match[2].startsWith('Developer ID Application:') && match[2].endsWith(`(${signing.teamId})`)) {
			matches.set(match[1], match[2]);
		}
	}
	assert.equal(matches.size, 1, 'Select a keychain with one valid Developer ID Application certificate for the configured team.');
	return { ...signing, identity: matches.values().next().value };
}

export async function notarize(path, signing, staplePath = path) {
	const { stdout } = await releaseCommand('/usr/bin/xcrun', [
		'notarytool',
		'submit',
		path,
		'--keychain-profile',
		signing.profile,
		...(signing.notaryKeychain ? ['--keychain', signing.notaryKeychain] : []),
		'--wait',
		'--output-format',
		'json',
	]);
	assert.equal(JSON.parse(stdout).status, 'Accepted', 'Apple notarization was not accepted.');
	await releaseCommand('/usr/bin/xcrun', ['stapler', 'staple', staplePath]);
	await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', staplePath]);
}

export async function verifySignature(path, teamId, runtime = false) {
	const { stderr } = await releaseCommand('/usr/bin/codesign', ['--display', '--verbose=4', path]);
	assert.ok(stderr.includes(`TeamIdentifier=${teamId}`) && stderr.includes('Authority=Developer ID Application:'), 'Unexpected Developer ID signature or Apple team.');
	assert.match(stderr, /^Timestamp=.+/m, 'Developer ID signatures require a secure timestamp.');
	assert.ok(!runtime || /flags=.*\(runtime\)/.test(stderr), 'Application must use Hardened Runtime.');
	await releaseCommand('/usr/bin/codesign', ['--verify', '--strict', path]);
}

export async function verifySignedDmg(path, teamId) {
	await verifySignature(path, teamId);
	await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', path]);
	await releaseCommand('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', path]);
}
