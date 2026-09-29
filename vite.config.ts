import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build so the whole game can be hosted as one HTML page.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: { chunkSizeWarningLimit: 4000 },
});
