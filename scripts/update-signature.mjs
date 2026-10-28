import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';

export function verifyUpdateSignature(contents, encodedSignature, encodedKey, version) {
	const keyLines = Buffer.from(encodedKey.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
	const signatureLines = Buffer.from(encodedSignature.trim(), 'base64').toString('utf8').trim().split(/\r?\n/);
	assert.equal(keyLines.length, 2, 'Invalid updater public key.');
	assert.equal(signatureLines.length, 4, 'Invalid updater signature.');
	const key = Buffer.from(keyLines[1], 'base64');
	const signature = Buffer.from(signatureLines[1], 'base64');
	const global = Buffer.from(signatureLines[3], 'base64');
	assert.equal(key.length, 42, 'Invalid public key length.');
	assert.equal(signature.length, 74, 'Invalid signature length.');
	assert.equal(global.length, 64, 'Invalid trusted-comment signature.');
	assert.equal(key.subarray(0, 2).toString(), 'Ed', 'Unsupported public key algorithm.');
	assert.equal(signature.subarray(0, 2).toString(), 'ED', 'Updates require a prehashed Minisign signature.');
	assert.deepEqual(signature.subarray(2, 10), key.subarray(2, 10), 'Updater key does not match this application.');
	assert.ok(signatureLines[2].startsWith('trusted comment: '), 'Missing trusted comment.');
	const comment = signatureLines[2].slice('trusted comment: '.length);
	const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
	assert.ok(verify(null, createHash('blake2b512').update(contents).digest(), publicKey, signature.subarray(10)), 'Update archive signature is invalid.');
	assert.ok(verify(null, Buffer.concat([signature.subarray(10), Buffer.from(comment)]), publicKey, global), 'Update trusted comment is invalid.');
	assert.equal(
		comment.split('\t').find((field) => field.startsWith('version:')),
		`version:${version}`,
		'Signed version does not match the update feed.',
	);
}
