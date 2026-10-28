import { execFile } from 'node:child_process';
import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resources = join(root, 'resources');
const document = join(resources, 'svnbox.icon');
const source = join(document, 'Assets/warehouse.png');
const previews = join(resources, 'icon-previews');
const composition = JSON.parse(await readFile(join(document, 'icon.json'), 'utf8'));
const sourceBytes = await readFile(source);
if (sourceBytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' || sourceBytes.readUInt32BE(16) !== 1024 || sourceBytes.readUInt32BE(20) !== 1024) {
	throw new Error('resources/svnbox.icon/Assets/warehouse.png 必须是 1024×1024 PNG；前景原图不会被构建脚本改写');
}
const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
const selected = await exec('/usr/bin/xcode-select', ['-p']);
const developer = selected.stdout.trim();
const ictool = resolve(developer, '../Applications/Icon Composer.app/Contents/Executables/ictool');
const version = JSON.parse((await exec(ictool, ['--version'])).stdout);
const generation = Number.parseInt(version['short-bundle-version'], 10);
if (generation < 27) {
	throw new Error('图标预览需要 Xcode / Icon Composer 27+；也可在 Composer 中直接编辑 resources/svnbox.icon');
}
await mkdir(previews, { recursive: true });
const modes = [
	['default', 'Default'],
	['dark', 'Dark'],
	['tinted', 'TintedDark'],
];
for (const [name, rendition] of modes) {
	await exec(ictool, [
		document,
		'--export-image',
		'--output-file',
		join(previews, `${name}.png`),
		'--platform',
		'macOS',
		'--rendition',
		rendition,
		'--width',
		'1024',
		'--height',
		'1024',
		'--scale',
		'1',
		'--design-generation',
		'27',
		...(name === 'tinted' ? ['--tint-color', '0.60', '--tint-strength', '0.60'] : []),
	]);
}
await copyFile(join(previews, 'default.png'), join(resources, 'icon.png'));
const temporary = await mkdtemp(join(tmpdir(), 'svnbox-icon-'));
try {
	const input = join(temporary, 'Icon.icon');
	const output = join(temporary, 'compiled');
	await cp(document, input, { recursive: true });
	await mkdir(output);
	const compilation = await exec(
		'/usr/bin/xcrun',
		[
			'actool',
			input,
			'--compile',
			output,
			'--output-format',
			'human-readable-text',
			'--notices',
			'--warnings',
			'--output-partial-info-plist',
			join(output, 'icon-info.plist'),
			'--app-icon',
			'Icon',
			'--include-all-app-icons',
			'--enable-on-demand-resources',
			'NO',
			'--development-region',
			'zh_CN',
			'--target-device',
			'mac',
			'--minimum-deployment-target',
			'26.0',
			'--platform',
			'macosx',
		],
		{ maxBuffer: 4 * 1024 * 1024 },
	);
	const legacy = await readFile(join(output, 'Icon.icns'));
	if (legacy.toString('ascii', 0, 4) !== 'icns' || legacy.readUInt32BE(4) !== legacy.length) {
		throw new Error('actool 未生成有效的兼容 ICNS');
	}
	await copyFile(join(output, 'Icon.icns'), join(resources, 'icon.icns'));
	await copyFile(join(output, 'Assets.car'), join(resources, 'Assets.car'));
	await mkdir(join(root, 'src-tauri/icons'), { recursive: true });
	await writeFile(join(root, 'src-tauri/icons/icon.png'), PNG.sync.write(PNG.sync.read(await readFile(join(resources, 'icon.png'))), { bitDepth: 8 }));
	await writeFile(join(previews, 'actool.log'), compilation.stdout + compilation.stderr);
	await writeFile(
		join(previews, 'source.json'),
		JSON.stringify(
			{
				source: 'resources/svnbox.icon/Assets/warehouse.png',
				sourceSha256,
				composerVersion: version['short-bundle-version'],
				artworkLayers: 1,
				nativeBackground: [composition.fill],
				previews: modes.map(([name]) => `${name}.png`),
			},
			null,
			2,
		) + '\n',
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
if (
	createHash('sha256')
		.update(await readFile(source))
		.digest('hex') !== sourceSha256
) {
	throw new Error('构建期间前景原图发生变化，请重新生成图标');
}
console.log(`图标已编译：透明仓盒前景 → 原生蓝色底板 → icon.png / icon.icns；Icon Composer ${version['short-bundle-version']}`);
