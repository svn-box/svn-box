import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import theme from '../src/renderer/src/assets/file-icons/symbols/theme.json';
import { resolveFileIcon } from '../src/renderer/src/lib/file-icons';

it.each([
	['src/app.ts', 'ts'],
	['src/App.tsx', 'react-ts'],
	['src/App.jsx', 'react'],
	['src/App.vue', 'vue'],
	['src/App.svelte', 'svelte'],
	['src/main.rs', 'rust'],
	['scripts/task.py', 'python'],
	['src/Window.swift', 'swift'],
	['src/server.php', 'php'],
	['src/main.clj', 'clojure'],
	['scripts/task.pl', 'perl'],
	['Makefile', 'gear'],
	['src/app.test.ts', 'ts-test'],
	['src/types.d.ts', 'ts-types'],
	['assets/海报.PNG', 'image'],
	['assets/mark.svg', 'svg'],
	['docs/guide.pdf', 'pdf'],
	['dist/archive.tar.gz', 'compressed'],
	['assets/music.flac', 'audio'],
	['assets/demo.mp4', 'video'],
	['assets/font.woff2', 'font'],
	['package.json', 'node'],
	['pnpm-lock.yaml', 'pnpm'],
	['vite.config.ts', 'vite'],
	['tsconfig.json', 'tsconfig'],
	['Dockerfile', 'docker'],
	['.gitignore', 'git'],
	['.env.custom-local', 'gear'],
	['README.md', 'readme'],
	['C:\\project\\src\\App.TSX', 'react-ts'],
])('recognizes %s, including specific filenames and compound extensions', (path, id) => {
	expect(resolveFileIcon(path).id).toBe(id);
});

it('resolves directory names separately from file extensions and supplies defaults', () => {
	expect(resolveFileIcon('src/components', 'dir').id).toBe('folder-components');
	expect(resolveFileIcon('assets', 'dir').id).toBe('folder-assets');
	expect(resolveFileIcon('backup.zip', 'dir').id).toBe(theme.folder);
	expect(resolveFileIcon('.', 'dir').id).toBe(theme.rootFolder);
	expect(resolveFileIcon('unknown.extension').id).toBe(theme.file);
	expect(resolveFileIcon('').id).toBe(theme.file);
	expect(resolveFileIcon('linked.ts', 'symlink').id).toBe('ts');
});

it('bundles an SVG for every upstream definition and association, including the link overlay', () => {
	const definitions: Record<string, { iconPath: string }> = theme.iconDefinitions;
	for (const id of [
		theme.file,
		theme.folder,
		theme.rootFolder,
		'link',
		...Object.values(theme.fileExtensions),
		...Object.values(theme.fileNames),
		...Object.values(theme.folderNames),
		...Object.values(theme.languageIds),
	]) {
		expect(definitions[id], id).toBeDefined();
	}
	for (const [id, definition] of Object.entries(definitions)) {
		const path = fileURLToPath(new URL(`../src/renderer/src/assets/file-icons/symbols/${definition.iconPath}`, import.meta.url));
		expect(existsSync(path), id).toBe(true);
	}
});
