import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const BUILD = String(Date.now());

// The truck game is its own single-file page, built next to the farming game at dist/truck/.
export default defineConfig({
  root: 'truck',
  base: './',
  plugins: [
    viteSingleFile(),
    // Lets a running copy of the game tell whether a newer build is online (see src/version.ts).
    { name: 'build-mark', transformIndexHtml: (html: string) => html.replace('</head>', `<meta name="eh-build" content="eh-build-${BUILD}"></head>`) },
  ],
  define: { __BUILD__: JSON.stringify(BUILD) },
  build: { outDir: '../dist/truck', emptyOutDir: false, chunkSizeWarningLimit: 4000 },
  server: { host: true },
});
