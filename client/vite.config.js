import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Shared content lives in ../data; '@data/projects.json' imports it from client code.
const dataDir = fileURLToPath(new URL('../data', import.meta.url));

// Dev server on 5173; /api is proxied to the Express server on 5000.
export default defineConfig({
  resolve: {
    alias: { '@data': dataDir },
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] }, // allow reading ../data in dev
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 800, // three.js is large by nature
  },
});
