import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'src/ui',
  base: './',
  // No publicDir: split-build apps must publish every file as a
  // content-hashed `assets/` entry — `serveBuiltUi` validates that at
  // build time and the Hub only ever re-serves manifest-listed files.
  publicDir: false,
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', '@privos_ai/app-react'],
        },
      },
    },
  },
  server: { port: 5173 },
});
