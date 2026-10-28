import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	root: 'src/renderer',
	resolve: { alias: { '@': fileURLToPath(new URL('./src/renderer/src', import.meta.url)) } },
	plugins: [react(), tailwindcss()],
	server: { host: '127.0.0.1', port: 1421, strictPort: true },
	build: { outDir: '../../dist', emptyOutDir: true, target: 'safari16.4' },
});
