import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { themes, themeIds, normalizeTheme, getTheme } from '../src/shared/themes';
import { emptySession } from '../src/shared/types';
import { Store } from '../src/main/store';
import { schemas } from '../src/shared/validation';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function contrast(foreground: string, background: string): number {
	const luminance = (hex: string) => {
		const channels = hex
			.slice(1)
			.match(/../g)!
			.map((value) => parseInt(value, 16) / 255)
			.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
		return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
	};
	const first = luminance(foreground);
	const second = luminance(background);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe('外观主题', () => {
	it('六套完整主题具有唯一ID、独立表面色和固定的系统明暗外观，拒绝旧系统选项', () => {
		expect(themes.map((theme) => theme.id)).toEqual([...themeIds]);
		expect(new Set(themes.map((theme) => theme.colors.sidebar)).size).toBe(6);
		for (const theme of themes) {
			expect(Object.keys(theme.colors).sort()).toEqual(Object.keys(themes[0].colors).sort());
			expect(schemas.settings.parse({ theme: theme.id })).toEqual({ theme: theme.id });
			expect(getTheme(theme.id).scheme).toBe(theme.scheme);
		}
		expect(schemas.settings.safeParse({ theme: 'system' }).success).toBe(false);
		expect(schemas.settings.safeParse({ theme: 'not-a-theme' }).success).toBe(false);
	});

	it('正文、次级文字、状态、焦点和按钮在各主题主要表面达到 AA 对比度', () => {
		const backgrounds = ['bg', 'canvas', 'sidebar', 'chrome', 'surface', 'raised', 'selected', 'hover', 'menu-surface'] as const;
		for (const theme of themes) {
			const colors = theme.colors;
			for (const foreground of ['text', 'muted', 'accent', 'danger', 'green', 'warning'] as const) {
				for (const background of backgrounds) {
					expect(contrast(colors[foreground], colors[background]), `${theme.id}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
				}
			}
			for (const desktop of [0, 255]) {
				const sidebar =
					'#' +
					colors.sidebar
						.slice(1)
						.match(/../g)!
						.map((value) =>
							Math.round(parseInt(value, 16) * 0.94 + desktop * 0.06)
								.toString(16)
								.padStart(2, '0'),
						)
						.join('');
				for (const foreground of ['text', 'muted', 'accent', 'danger', 'green', 'warning'] as const) {
					expect(contrast(colors[foreground], sidebar), `${theme.id} native sidebar: ${foreground}`).toBeGreaterThanOrEqual(4.5);
				}
			}
			expect(contrast(colors['on-accent'], colors['accent-strong']), `${theme.id} primary button`).toBeGreaterThanOrEqual(4.5);
			expect(contrast(colors.green, colors['diff-added']), `${theme.id} added Diff`).toBeGreaterThanOrEqual(4.5);
			expect(contrast(colors.danger, colors['diff-deleted']), `${theme.id} deleted Diff`).toBeGreaterThanOrEqual(4.5);
			for (const background of ['input', 'canvas', 'chrome'] as const) {
				expect(contrast(colors['border-input'], colors[background]), `${theme.id} input/focus border`).toBeGreaterThanOrEqual(3);
			}
		}
	});

	it('旧跟随系统/无效外观迁移为白色，静态主题及其他配置正常持久化', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'svnbox-theme-'));
		directories.push(directory);
		const store = new Store(directory);
		await store.load();
		expect(store.get().settings.theme).toBe('light');
		await store.change((state) => {
			state.settings.mergeTool = '/Applications/自定义合并工具.app';
			state.sessions.test = { ...emptySession(), draft: '不可丢失的草稿' };
		});
		const path = join(directory, 'workspace.json');
		const legacy = JSON.parse(await readFile(path, 'utf8'));
		legacy.settings.theme = 'system';
		await writeFile(path, JSON.stringify(legacy));
		const migrated = new Store(directory);
		await migrated.load();
		expect(migrated.get().settings.theme).toBe('light');
		expect(migrated.get().sessions.test.draft).toBe('不可丢失的草稿');
		for (const theme of themes) {
			await migrated.change((state) => {
				state.settings.theme = theme.id;
			});
			const restored = new Store(directory);
			await restored.load();
			expect(restored.get().settings.theme).toBe(theme.id);
			expect(restored.get().settings.mergeTool).toBe(legacy.settings.mergeTool);
		}
		expect(normalizeTheme('future-theme')).toBe('light');
		expect(normalizeTheme('system')).toBe('light');
	});
});
