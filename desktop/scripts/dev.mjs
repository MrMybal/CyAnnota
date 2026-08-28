import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const projectRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const rendererUrl = 'http://127.0.0.1:5174';
const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
let stopping = false;

const renderer = spawn(
  process.execPath,
  [
    viteCli,
    '--config',
    path.join(projectRoot, 'desktop', 'vite.config.ts'),
  ],
  {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  },
);

async function waitForRenderer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (renderer.exitCode !== null) {
      throw new Error('Le serveur de rendu Electron s’est arrêté avant son démarrage.');
    }
    try {
      const response = await fetch(rendererUrl, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) return;
    } catch {
      // Le serveur est encore en cours de démarrage.
    }
    await delay(150);
  }
  throw new Error('Le rendu Electron ne répond pas après 30 secondes.');
}

function stopChild(child) {
  if (child && child.exitCode === null && !child.killed) {
    child.kill();
  }
}

let desktop = null;

async function start() {
  await waitForRenderer();

  desktop = spawn(electronPath, [projectRoot], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CYANNOTA_RENDERER_URL: rendererUrl,
    },
  });

  desktop.on('exit', (code) => {
    stopping = true;
    stopChild(renderer);
    process.exitCode = code ?? 0;
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  stopChild(desktop);
  stopChild(renderer);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', shutdown);

start().catch((error) => {
  console.error(error.message);
  shutdown();
  process.exitCode = 1;
});