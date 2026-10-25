import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
	main: { plugins: [externalizeDepsPlugin()] },
	preload: { plugins: [externalizeDepsPlugin()] },
	renderer: {
		resolve: {
			alias: { '@': resolve('src/renderer/src') },
		},
		plugins: [react(), tailwindcss()],
		server: { host: '127.0.0.1' },
	},
});
