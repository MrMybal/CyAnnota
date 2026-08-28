const { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DESKTOP_SCHEME = 'cyannota';
const DESKTOP_ORIGIN = 'cyannota://app';
const DEVELOPMENT_ORIGIN = 'http://127.0.0.1:5174';

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow = null;
let lastSaveDirectory = null;
const pendingSavePaths = new Map();

function preferencesFilePath() {
  return path.join(app.getPath('userData'), 'desktop-preferences.json');
}

async function loadDesktopPreferences() {
  try {
    const preferences = JSON.parse(await fs.readFile(preferencesFilePath(), 'utf8'));
    const directory = preferences?.lastSaveDirectory;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) return;
    const stats = await fs.stat(directory);
    if (stats.isDirectory()) lastSaveDirectory = directory;
  } catch {
    lastSaveDirectory = null;
  }
}

async function rememberSaveDirectory(filePath) {
  const directory = path.dirname(filePath);
  lastSaveDirectory = directory;
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  await fs.writeFile(
    preferencesFilePath(),
    JSON.stringify({ lastSaveDirectory: directory }, null, 2),
    'utf8',
  );
}

function isTrustedAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (app.isPackaged) {
      return url.protocol === DESKTOP_SCHEME + ':' && url.host === 'app';
    }
    return url.origin === DEVELOPMENT_ORIGIN;
  } catch {
    return false;
  }
}

function registerDesktopProtocol() {
  const rendererRoot = path.resolve(__dirname, 'dist', 'renderer');

  protocol.handle(DESKTOP_SCHEME, (request) => {
    const requestUrl = new URL(request.url);
    const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '') || 'index.html';
    const requestedFile = path.resolve(rendererRoot, relativePath);
    const pathFromRoot = path.relative(rendererRoot, requestedFile);

    if (pathFromRoot.startsWith('..') || path.isAbsolute(pathFromRoot)) {
      return new Response('Fichier introuvable', { status: 404 });
    }

    return net.fetch(pathToFileURL(requestedFile).toString());
  });
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedAppUrl(senderUrl)) {
    throw new Error('Origine de sauvegarde refusée');
  }
}

function saveDialogOptions(name) {
  const suggestedName =
    typeof name === 'string'
      ? path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      : 'cyannota-espace-de-travail.zip';
  const extension = path.extname(suggestedName).toLowerCase();
  const filters =
    extension === '.zip'
      ? [{ name: 'Archive CyAnnota', extensions: ['zip'] }]
      : extension === '.png'
        ? [{ name: 'Image PNG', extensions: ['png'] }]
        : [{ name: 'Tous les fichiers', extensions: ['*'] }];

  return {
    title: 'Enregistrer avec CyAnnota',
    defaultPath: path.join(lastSaveDirectory || app.getPath('downloads'), suggestedName),
    filters,
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  };
}

function getPendingSave(event, payload) {
  const token = typeof payload?.token === 'string' ? payload.token : '';
  const pending = pendingSavePaths.get(token);
  if (!pending || pending.senderId !== event.sender.id) {
    throw new Error('La destination de sauvegarde a expiré. Recommencez l’enregistrement.');
  }
  return { token, pending };
}

async function closePendingHandle(pending) {
  if (!pending.handle) return;
  const handle = pending.handle;
  pending.handle = null;
  await handle.close();
}

async function abortPendingSave(token, pending) {
  try {
    await closePendingHandle(pending);
  } finally {
    await fs.rm(pending.tempPath, { force: true }).catch(() => undefined);
    pendingSavePaths.delete(token);
  }
}

async function writeCompleteBuffer(handle, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (!result.bytesWritten) {
      throw new Error('L’écriture du fichier s’est interrompue sans explication.');
    }
    offset += result.bytesWritten;
  }
}

function saveErrorDetail(error, filePath) {
  const detail = error instanceof Error ? error.message : String(error);
  return `Impossible d’enregistrer « ${filePath} ». ${detail}`;
}

function registerDesktopIpc() {
  ipcMain.handle('cyannota:choose-save-file', async (event, payload) => {
    assertTrustedSender(event);

    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const result = await dialog.showSaveDialog(owner, saveDialogOptions(payload?.name));
    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const now = Date.now();
    for (const [expiredToken, expiredPending] of pendingSavePaths) {
      if (now - expiredPending.createdAt > 10 * 60 * 1000) {
        await abortPendingSave(expiredToken, expiredPending);
      }
    }

    const token = randomUUID();
    pendingSavePaths.set(token, {
      filePath: result.filePath,
      tempPath: path.join(app.getPath('temp'), `cyannota-${token}.tmp`),
      senderId: event.sender.id,
      createdAt: now,
      handle: null,
      bytesWritten: 0,
    });
    return { canceled: false, token };
  });

  ipcMain.handle('cyannota:begin-save-file', async (event, payload) => {
    assertTrustedSender(event);
    const { pending } = getPendingSave(event, payload);
    if (pending.handle) {
      throw new Error('Une écriture est déjà en cours pour ce fichier.');
    }

    try {
      pending.handle = await fs.open(pending.tempPath, 'w');
      pending.bytesWritten = 0;
      return { started: true };
    } catch (error) {
      throw new Error(saveErrorDetail(error, pending.filePath));
    }
  });

  ipcMain.handle('cyannota:write-save-chunk', async (event, payload) => {
    assertTrustedSender(event);
    const { pending } = getPendingSave(event, payload);
    if (!pending.handle) {
      throw new Error('L’écriture du fichier n’a pas été initialisée.');
    }

    const base64 = payload?.base64;
    if (
      typeof base64 !== 'string' ||
      base64.length === 0 ||
      base64.length > 2 * 1024 * 1024 ||
      base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    ) {
      throw new Error('Un bloc de données du ZIP est invalide.');
    }

    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.byteLength) {
      throw new Error('Un bloc de données du ZIP est vide.');
    }

    try {
      await writeCompleteBuffer(pending.handle, bytes);
      pending.bytesWritten += bytes.byteLength;
      return { written: bytes.byteLength };
    } catch (error) {
      throw new Error(saveErrorDetail(error, pending.filePath));
    }
  });

  ipcMain.handle('cyannota:finish-save-file', async (event, payload) => {
    assertTrustedSender(event);
    const { token, pending } = getPendingSave(event, payload);
    if (!pending.handle) {
      throw new Error('Aucune écriture n’est en cours pour ce fichier.');
    }

    try {
      await pending.handle.sync();
      await closePendingHandle(pending);
      if (!pending.bytesWritten) {
        throw new Error('Le fichier généré est vide.');
      }
      await fs.copyFile(pending.tempPath, pending.filePath);
      await fs.rm(pending.tempPath, { force: true });
      await rememberSaveDirectory(pending.filePath).catch((error) => {
        console.warn('Impossible de mémoriser le dossier de sauvegarde', error);
      });
      pendingSavePaths.delete(token);
      return { saved: true, bytesWritten: pending.bytesWritten };
    } catch (error) {
      await abortPendingSave(token, pending);
      throw new Error(saveErrorDetail(error, pending.filePath));
    }
  });

  ipcMain.handle('cyannota:abort-save-file', async (event, payload) => {
    assertTrustedSender(event);
    const token = typeof payload?.token === 'string' ? payload.token : '';
    const pending = pendingSavePaths.get(token);
    if (!pending) return { aborted: true };
    if (pending.senderId !== event.sender.id) {
      throw new Error('Cette sauvegarde appartient à une autre fenêtre.');
    }
    await abortPendingSave(token, pending);
    return { aborted: true };
  });

  ipcMain.handle('cyannota:show-error-message', async (event, payload) => {
    assertTrustedSender(event);
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const title = typeof payload?.title === 'string' ? payload.title.slice(0, 120) : 'CyAnnota - erreur';
    const message =
      typeof payload?.message === 'string'
        ? payload.message.slice(0, 300)
        : 'L’enregistrement a échoué.';
    const detail =
      typeof payload?.detail === 'string'
        ? payload.detail.slice(0, 4000)
        : 'Aucun détail technique n’est disponible.';

    await dialog.showMessageBox(owner, {
      type: 'error',
      title,
      message,
      detail,
      buttons: ['Fermer'],
      defaultId: 0,
      noLink: true,
    });
    return { shown: true };
  });
}
function createMainWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#151514',
    title: 'CyAnnota',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  const developmentUrl = process.env.CYANNOTA_RENDERER_URL;
  const targetUrl =
    !app.isPackaged && developmentUrl === DEVELOPMENT_ORIGIN
      ? developmentUrl
      : DESKTOP_ORIGIN + '/index.html';

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
      shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedAppUrl(url)) return;
    event.preventDefault();
    if (url.startsWith('https://')) {
      shell.openExternal(url).catch(() => undefined);
    }
  });

  window.loadURL(targetUrl);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window;
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.cyberalien.cyannota');
  await loadDesktopPreferences();

  if (app.isPackaged) {
    registerDesktopProtocol();
  }
  registerDesktopIpc();

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || details.securityOrigin || '';
    callback(permission === 'clipboard-read' && isTrustedAppUrl(requestingUrl));
  });

  mainWindow = createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});