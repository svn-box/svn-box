import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const signingVariables = ['APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'CSC_KEYCHAIN'];

export function requireSigningEnvironment(env = process.env) {
	for (const name of signingVariables) {
		assert.ok(env[name]?.trim(), `Missing ${name}; signed releases never fall back to unsigned builds.`);
	}
	assert.match(env.APPLE_TEAM_ID, /^[A-Z\d]{10}$/, 'Apple team must be ten uppercase letters or digits.');
	return { teamId: env.APPLE_TEAM_ID, keychain: env.CSC_KEYCHAIN };
}

export async function releaseCommand(tool, arguments_, env = process.env) {
	try {
		return await execute(tool, arguments_, { env, maxBuffer: 32 * 1024 * 1024, timeout: 45 * 60 * 1000 });
	} catch {
		throw new Error(`${tool} failed during release verification. Arguments and output were withheld to protect credentials.`);
	}
}

export async function prepareSigning(env = process.env) {
	const signing = requireSigningEnvironment(env);
	const { stdout } = await releaseCommand('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning', signing.keychain]);
	const identity = stdout.match(new RegExp(`"(Developer ID Application: [^"\\r\\n]+ \\(${signing.teamId}\\))"`))?.[1];
	assert.ok(identity, 'Temporary keychain has no Developer ID Application identity for this team.');
	await releaseCommand('/usr/bin/xcrun', [
		'notarytool',
		'store-credentials',
		'svnbox-notary',
		'--apple-id',
		env.APPLE_ID,
		'--team-id',
		signing.teamId,
		'--password',
		env.APPLE_APP_SPECIFIC_PASSWORD,
		'--keychain',
		signing.keychain,
	]);
	return { ...signing, identity };
}

export async function notarize(path, keychain, staplePath = path) {
	const { stdout } = await releaseCommand('/usr/bin/xcrun', [
		'notarytool',
		'submit',
		path,
		'--keychain-profile',
		'svnbox-notary',
		'--keychain',
		keychain,
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
	assert.ok(!runtime || /flags=.*\(runtime\)/.test(stderr), 'Application must use Hardened Runtime.');
	await releaseCommand('/usr/bin/codesign', ['--verify', '--strict', path]);
}

export async function verifySignedDmg(path, teamId) {
	await verifySignature(path, teamId);
	await releaseCommand('/usr/bin/xcrun', ['stapler', 'validate', path]);
	await releaseCommand('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', path]);
}
