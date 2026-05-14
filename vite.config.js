import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const repoRoot = path.dirname(new URL(import.meta.url).pathname);

// Built artifacts land in ./public, which Express serves via app.use(express.static('public')).
// We keep the build output committed to git so deployment never runs Vite — the auto-update loop
// stays a pure `git checkout && npm ci --omit=dev && node index.js`.
export default defineConfig({
  root: path.join(repoRoot, 'client'),
  plugins: [react()],
  build: {
    outDir: path.join(repoRoot, 'public'),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    assetsInlineLimit: 4096,
  },
  server: {
    port: 5173,
    proxy: {
      '/api':    { target: 'http://localhost:1982', changeOrigin: true },
      '/ws':     { target: 'ws://localhost:1982',   ws: true },
    },
  },
});
