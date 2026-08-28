import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { defineConfig } from 'vite';

const desktopDirectory = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = path.resolve(desktopDirectory, '..');

export default defineConfig({
  root: path.join(desktopDirectory, 'renderer'),
  publicDir: path.join(projectRoot, 'public'),
  base: './',
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    fs: {
      allow: [projectRoot],
    },
  },
  build: {
    outDir: path.join(desktopDirectory, 'dist', 'renderer'),
    emptyOutDir: true,
  },
});