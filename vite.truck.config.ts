import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The truck game is its own single-file page, built next to the farming game at dist/truck/.
export default defineConfig({
  root: 'truck',
  base: './',
  plugins: [viteSingleFile()],
  build: { outDir: '../dist/truck', emptyOutDir: false, chunkSizeWarningLimit: 4000 },
  server: { host: true },
});
