import path from 'node:path';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { defineConfig } from 'vite';

const webDirectory = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = path.resolve(webDirectory, '..');
const outputDirectory = path.join(projectRoot, 'dist', 'pages');
const base = process.env.CYANNOTA_PAGES_BASE || '/CyAnnota/';

if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) {
  throw new Error('CYANNOTA_PAGES_BASE must be an absolute path ending in /, such as /CyAnnota/.');
}

export default defineConfig({
  root: webDirectory,
  // Copy only the public assets this application uses.
  publicDir: false,
  base,
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [
    react(),
    {
      name: 'cyannota-pages-assets',
      apply: 'build',
      async closeBundle() {
        for (const name of ['cyannota-logo.png', 'favicon.svg', 'cyannota-integration.js', 'cyannota-ai.js']) {
          await copyFile(path.join(projectRoot, 'public', name), path.join(outputDirectory, name));
        }
        for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
          await copyFile(path.join(projectRoot, name), path.join(outputDirectory, name));
        }
        const ffmpegDirectory = path.join(projectRoot, 'public', 'ffmpeg');
        const ffmpegOutput = path.join(outputDirectory, 'ffmpeg');
        await mkdir(ffmpegOutput, { recursive: true });
        for (const name of await readdir(ffmpegDirectory)) {
          if (name === 'ffmpeg-core.js' || name === 'ffmpeg-core.wasm.parts.json' || /^ffmpeg-core\.wasm\.part\d+$/.test(name)) {
            await copyFile(path.join(ffmpegDirectory, name), path.join(ffmpegOutput, name));
          }
        }
        await writeFile(path.join(outputDirectory, '.nojekyll'), '');
      },
    },
  ],
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    sourcemap: false,
  },
});
