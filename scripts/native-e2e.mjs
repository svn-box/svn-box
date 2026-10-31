import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createUpdateFixture } from './native-update-fixture.mjs';

const output = resolve('work/native');
const release = process.argv.length === 3 && process.argv[2] === '--release';
assert.ok(process.argv.length === 2 || release, 'Only --release is supported.');
await mkdir(output, { recursive: true });
await rm(join(output, 'report.json'), { force: true });
const root = await mkdtemp(join(tmpdir(), 'svnbox-tauri-native-'));
let updater;

function run(command, args, options = {}) {
	return new Promise((done, reject) => {
		const child = spawn(command, args, { stdio: 'inherit', ...options });
		child.once('error', reject);
		child.once('exit', (code) => (code === 0 ? done() : reject(new Error(`${command} exited ${code}`))));
	});
}

function svn(...args) {
	return execFileSync('/opt/homebrew/bin/svn', args, { encoding: 'utf8' });
}

try {
	updater = await createUpdateFixture(root);
	const buildEnv = { ...process.env, TAURI_CONFIG: JSON.stringify({ identifier: 'app.svnbox.desktop.smoke', plugins: { updater: updater.config } }) };
	const repository = join(root, 'repository');
	const wc = join(root, 'working-copy');
	execFileSync('/opt/homebrew/bin/svnadmin', ['create', repository]);
	const url = pathToFileURL(repository).href;
	svn('mkdir', `${url}/trunk`, '-m', 'Create trunk');
	svn('checkout', `${url}/trunk`, wc);
	await writeFile(join(wc, 'README.md'), 'initial\n');
	await writeFile(join(wc, 'other.txt'), 'other\n');
	svn('add', '--force', wc);
	svn('commit', wc, '-m', 'Initial files');
	await writeFile(join(wc, 'README.md'), 'native edit\n');
	await writeFile(join(wc, 'other.txt'), 'other native edit\n');
	await run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--features', 'native-smoke,tauri/custom-protocol', ...(release ? ['--release'] : [])], {
		env: buildEnv,
	});
	await run(resolve(`src-tauri/target/${release ? 'release' : 'debug'}/svnbox-app`), [], {
		env: {
			...buildEnv,
			SVNBOX_DATA_DIR: join(root, 'data'),
			SVNBOX_SMOKE_OUTPUT: output,
			SVNBOX_SMOKE_WC: wc,
			SVNBOX_SMOKE_SVN: resolve('resources/svn/darwin-arm64/bin/svn'),
			SVNBOX_SMOKE_UPDATER: '1',
		},
		timeout: 90000,
	}).catch(async (error) => {
		const report = await readFile(join(output, 'report.json'), 'utf8')
			.then(JSON.parse)
			.catch(() => null);
		throw new Error(report?.error || 'Native application exited without a report', { cause: error });
	});
	const report = JSON.parse(await readFile(join(output, 'report.json'), 'utf8'));
	assert.equal(report.success, true, report.error);
	updater.verify();
	console.log(`PASS: ${report.checks.length} native WebKit / Rust checks. Screenshots: ${output}`);
} finally {
	await updater?.close();
	await rm(root, { recursive: true, force: true });
}
