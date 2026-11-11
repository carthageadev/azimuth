import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { outDir: 'dist', assetsInlineLimit: 100 * 1024 * 1024 },
  server: { host: true, port: 5173 }
});
