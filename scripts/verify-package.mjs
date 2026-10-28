import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const bundle = resolve('src-tauri/target/release/bundle');
const application = join(bundle, 'macos/仓盒.app');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const installer = join(bundle, `dmg/仓盒_${version}_aarch64.dmg`);
const digest = async (path) =>
	createHash('sha256')
		.update(await readFile(path))
		.digest('hex');

export async function verifyApplication(app) {
	const resources = join(app, 'Contents/Resources');
	const binary = join(app, 'Contents/MacOS/svnbox-app');
	const info = JSON.parse((await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')])).stdout);
	assert.equal(info.CFBundleIdentifier, 'app.svnbox.desktop');
	assert.equal(info.CFBundleShortVersionString, version);
	assert.equal(info.CFBundleIconName, 'Icon');
	assert.ok((await exec('/usr/bin/file', [binary])).stdout.includes('arm64'));
	await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
	assert.equal(await digest(join(resources, 'Assets.car')), await digest('resources/Assets.car'));
	assert.equal(await digest(join(resources, info.CFBundleIconFile)), await digest('resources/icon.icns'));
	for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
		assert.equal(await digest(join(resources, file)), await digest(file));
	}
	for (const name of await readdir('resources/licenses', { recursive: true })) {
		const source = join('resources/licenses', name);
		if ((await stat(source)).isFile()) {
			assert.equal(await digest(join(resources, source)), await digest(source), `Packaged notice differs: ${name}`);
		}
	}
	const strings = (await exec('/usr/bin/strings', [binary], { maxBuffer: 32 * 1024 * 1024 })).stdout;
	for (const marker of ['smoke_report', 'smoke_snapshot', 'SVNBOX_SMOKE_OUTPUT', 'SVNBOX_SMOKE_SVN', 'smoke_menu', 'electron-updater']) {
		assert.ok(!strings.includes(marker), `Production binary contains ${marker}`);
	}
	assert.ok(!(await readdir(join(app, 'Contents/Frameworks')).catch(() => [])).some((name) => /electron|chromium/i.test(name)));
	const runtime = JSON.parse(await readFile(join(resources, 'svn/manifest.json'), 'utf8'));
	assert.equal((await exec(join(resources, 'svn/bin/svn'), ['--version', '--quiet'])).stdout.trim(), runtime.version);
	for (const entry of ['bin/svn', ...(await readdir(join(resources, 'svn/lib'))).map((name) => `lib/${name}`)]) {
		const dependencies = (await exec('/usr/bin/otool', ['-L', join(resources, 'svn', entry)])).stdout
			.split('\n')
			.slice(1)
			.filter((line) => line.trim());
		assert.ok(
			dependencies.every((line) => /^\s*(\/usr\/lib\/|\/System\/Library\/|@loader_path\/|@executable_path\/)/.test(line)),
			`Unresolved native dependency: ${entry}`,
		);
	}
	const names = await readdir(app, { recursive: true });
	assert.ok(!names.some((name) => /app\.asar|(^|\/)node_modules(\/|$)|(^|\/)node$/.test(name)), 'Application contains an Electron or Node runtime.');
	return digest(binary);
}

async function main() {
	await mkdir('work', { recursive: true });
	const executableHash = await verifyApplication(application);
	await exec('/usr/bin/hdiutil', ['verify', installer]);
	const mount = resolve('work/dmg-mount');
	await mkdir(mount, { recursive: true });
	await exec('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, installer]);
	try {
		assert.equal(await verifyApplication(join(mount, '仓盒.app')), executableHash);
	} finally {
		await exec('/usr/bin/hdiutil', ['detach', mount]);
	}
	let appBytes = 0;
	for (const name of await readdir(application, { recursive: true })) {
		const file = await stat(join(application, name));
		if (file.isFile()) {
			appBytes += file.size;
		}
	}
	const report = { version, application, installer, appBytes, dmgBytes: (await stat(installer)).size, sha256: await digest(installer), executableHash };
	await writeFile('work/package-report.json', JSON.stringify(report, null, 2) + '\n');
	console.log(
		`PASS: app + mounted DMG, arm64, code signature, native icon catalog, legal notices, identical executables, and test hooks excluded. App ${(appBytes / 1048576).toFixed(2)} MiB; DMG ${(report.dmgBytes / 1048576).toFixed(2)} MiB.`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
