import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const files = [
	'.editorconfig',
	'.gitattributes',
	'.gitignore',
	'.prettierrc.json',
	'AGENTS.md',
	'LICENSE',
	'README.md',
	'README.zh-CN.md',
	'THIRD_PARTY_NOTICES.md',
	'package.json',
	'package-lock.json',
	'tsconfig.json',
	'vite.config.mts',
	'vitest.config.mts',
	'src-tauri/Cargo.toml',
	'src-tauri/Cargo.lock',
	'src-tauri/rustfmt.toml',
	'src-tauri/tauri.conf.json',
	'src-tauri/Info.plist',
];
for (const root of ['src', 'src-tauri/src', 'scripts', 'tests', 'docs', '.github']) {
	for (const name of await readdir(root, { recursive: true })) {
		if (/\.(?:tsx?|mts|mjs|js|css|html|svg|rs|json|toml|md|ya?ml)$/.test(name)) {
			files.push(join(root, name));
		}
	}
}
const decoder = new TextDecoder('utf-8', { fatal: true });
for (const file of files) {
	const bytes = await readFile(file);
	if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
		throw new Error(`${file}: remove the UTF-8 BOM.`);
	}
	const text = decoder.decode(bytes);
	if (text.includes('\r') || (text && !text.endsWith('\n'))) {
		throw new Error(`${file}: use LF line endings and a final newline.`);
	}
}
console.log(`Verified UTF-8 without BOM and LF newlines in ${files.length} project files.`);
