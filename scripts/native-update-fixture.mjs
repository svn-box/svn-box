import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

async function cli(arguments_, env = process.env) {
	try {
		await execute(process.execPath, [resolve('node_modules/@tauri-apps/cli/tauri.js'), ...arguments_], { env, timeout: 30000 });
	} catch {
		throw new Error('Native updater fixture could not be signed; private output withheld.');
	}
}

export async function createUpdateFixture(root) {
	const current = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version;
	const [major, minor, patch] = current.split('.').map(Number);
	const version = `${major}.${minor}.${patch + 1}`;
	const keyPath = join(root, 'throwaway.key');
	await cli(['signer', 'generate', '--ci', '--password', '', '--write-keys', keyPath]);
	const pubkey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();
	const bytes = randomBytes(2 * 1024 * 1024);
	const archive = join(root, 'fixture.app.tar.gz');
	await writeFile(archive, bytes);
	await cli(['signer', 'sign', '--app-version', version, archive], {
		...process.env,
		TAURI_SIGNING_PRIVATE_KEY: await readFile(keyPath, 'utf8'),
		TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
	});
	const signature = (await readFile(`${archive}.sig`, 'utf8')).trim();
	const transfers = [];
	let base;
	const server = createServer((request, response) => {
		if (request.url === '/latest.json') {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ version, notes: 'Native updater regression fixture.', platforms: { 'darwin-aarch64': { url: `${base}/fixture`, signature } } }));
			return;
		}
		if (request.url !== '/fixture') {
			response.writeHead(404).end();
			return;
		}
		const attempt = transfers.length;
		const transfer = { completed: false };
		transfers.push(transfer);
		const body = Buffer.from(bytes);
		// Reject tampering, cancel an unknown-length transfer, then download verified bytes.
		if (attempt === 0) {
			body[0] ^= 1;
		}
		response.writeHead(200, { 'Content-Type': 'application/octet-stream', ...(attempt === 1 ? {} : { 'Content-Length': body.length }) });
		response.flushHeaders();
		let offset = 0;
		const timer = setInterval(
			() => {
				const end = Math.min(offset + 32768, body.length);
				response.write(body.subarray(offset, end));
				offset = end;
				if (offset === body.length) {
					transfer.completed = true;
					clearInterval(timer);
					response.end();
				}
			},
			attempt === 0 ? 10 : 100,
		);
		response.on('close', () => clearInterval(timer));
	});
	await new Promise((done, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', done);
	});
	base = `http://127.0.0.1:${server.address().port}`;
	return {
		config: { pubkey, endpoints: [`${base}/latest.json`], dangerousInsecureTransportProtocol: true },
		verify: () => {
			assert.deepEqual(
				transfers.map((transfer) => transfer.completed),
				[true, false, true],
				'The updater must reject tampering, abort cancellation and finish one verified retry.',
			);
		},
		close: () =>
			new Promise((done) => {
				server.closeAllConnections();
				server.close(done);
			}),
	};
}
