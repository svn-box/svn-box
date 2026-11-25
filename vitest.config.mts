import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	test: { exclude: [...configDefaults.exclude, 'work/**', 'release/**', 'src-tauri/target/**'] },
	resolve: { alias: { '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)) } },
});
