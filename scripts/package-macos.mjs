import assert from 'node:assert/strict';
import { verifyUpdateSignature } from './update-signature.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const bundles = process.argv[2] ?? 'app';
assert.ok(['app', 'app,dmg'].includes(bundles), 'Choose app or app,dmg.');
const signed = process.argv.includes('--signed');
const definition = JSON.parse(await readFile('package.json', 'utf8'));
const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
assert.equal(definition.version, config.version, 'Package and Tauri versions must agree.');
const env = { ...process.env };
const localKey = join(homedir(), '.config/svnbox/signing/tauri-updater.key');
let hasKey = !!env.TAURI_SIGNING_PRIVATE_KEY;
if (
	!hasKey &&
	(await access(localKey).then(
		() => true,
		() => false,
	))
) {
	env.TAURI_SIGNING_PRIVATE_KEY = localKey;
	env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
	hasKey = true;
}
const override = { bundle: { createUpdaterArtifacts: hasKey } };
if (signed) {
	for (const name of ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_TEAM_ID']) {
		assert.ok(env[name]?.trim(), `${name} is required for a signed release.`);
	}
	env.APPLE_PASSWORD ??= env.APPLE_APP_SPECIFIC_PASSWORD;
	assert.ok(env.APPLE_PASSWORD, 'An Apple notarization app password is required.');
	assert.ok(env.APPLE_SIGNING_IDENTITY.startsWith('Developer ID Application:'), 'Use a Developer ID Application identity.');
	assert.ok(hasKey, 'A signed release requires the dedicated SVNBox updater key.');
	override.bundle.macOS = { signingIdentity: env.APPLE_SIGNING_IDENTITY };
}

function run(command, args) {
	return new Promise((done, reject) => {
		const child = spawn(command, args, { env, stdio: 'inherit' });
		child.once('error', reject);
		child.once('exit', (code) => (code === 0 ? done() : reject(new Error(`${command} exited ${code}`))));
	});
}

for (const script of ['svn:build', 'icons:build', 'licenses:check']) {
	await run('npm', ['run', script]);
}
await run(resolve('node_modules/.bin/tauri'), ['build', '--ci', '--bundles', bundles, '--config', JSON.stringify(override)]);
const directory = resolve('src-tauri/target/release/bundle/macos');
const app = join(directory, '仓盒.app');
const resources = join(app, 'Contents/Resources');
for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
	assert.deepEqual(await readFile(join(resources, name)), await readFile(name), `Packaged ${name} differs.`);
}
const runtime = JSON.parse(await readFile(join(resources, 'svn/manifest.json'), 'utf8'));
assert.equal(execFileSync(join(resources, 'svn/bin/svn'), ['--version', '--quiet'], { encoding: 'utf8' }).trim(), runtime.version);
for (const entry of ['bin/svn', ...(await readdir(join(resources, 'svn/lib'))).map((name) => `lib/${name}`)]) {
	const dependencies = execFileSync('/usr/bin/otool', ['-L', join(resources, 'svn', entry)], { encoding: 'utf8' })
		.split('\n')
		.slice(1)
		.filter((line) => line.trim());
	assert.ok(
		dependencies.every((line) => /^\s*(\/usr\/lib\/|\/System\/Library\/|@loader_path\/|@executable_path\/)/.test(line)),
		`Unresolved native dependency: ${entry}`,
	);
}
const names = await readdir(app, { recursive: true });
assert.ok(!names.some((name) => /Electron Framework|app\.asar|(^|\/)node_modules(\/|$)|(^|\/)node$/.test(name)), 'The application must contain no Electron or Node runtime.');
if (signed) {
	execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
	execFileSync('/usr/bin/xcrun', ['stapler', 'validate', app]);
	execFileSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
}
const destination = resolve(`release/${signed ? '' : 'preview/'}${definition.version}/macos/arm64`);
await mkdir(destination, { recursive: true });
const archive = `svnbox-${definition.version}-arm64.app.tar.gz`;
if (hasKey) {
	await copyFile(join(directory, '仓盒.app.tar.gz'), join(destination, archive));
	await copyFile(join(directory, '仓盒.app.tar.gz.sig'), join(destination, `${archive}.sig`));
	const signature = (await readFile(join(destination, `${archive}.sig`), 'utf8')).trim();
	verifyUpdateSignature(await readFile(join(destination, archive)), signature, config.plugins.updater.pubkey, definition.version);
	await writeFile(
		join(destination, 'latest.json'),
		JSON.stringify(
			{
				version: definition.version,
				notes: 'SVNBox Tauri / Rust',
				pub_date: new Date().toISOString(),
				platforms: { 'darwin-aarch64': { signature, url: `https://github.com/svn-box/svn-box/releases/download/v${definition.version}/${archive}` } },
			},
			null,
			2,
		) + '\n',
	);
}
if (bundles.includes('dmg')) {
	const dmgs = (await readdir('src-tauri/target/release/bundle/dmg')).filter((name) => name.endsWith('.dmg') && name.includes(`_${definition.version}_`));
	assert.equal(dmgs.length, 1, 'Expected one DMG.');
	await copyFile(join('src-tauri/target/release/bundle/dmg', dmgs[0]), join(destination, `svnbox-${definition.version}-arm64.dmg`));
}
const sums = [];
for (const name of (await readdir(destination)).filter((name) => name !== 'SHA256SUMS.txt').sort()) {
	sums.push(
		`${createHash('sha256')
			.update(await readFile(join(destination, name)))
			.digest('hex')}  ${name}`,
	);
}
await writeFile(join(destination, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`Verified ${signed ? 'signed' : 'local ad-hoc'} application: ${app}`);
console.log(`Artifacts: ${destination}`);
