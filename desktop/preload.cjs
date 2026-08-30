const { contextBridge, ipcRenderer } = require('electron');

const openFileListeners = new Set();
const pendingOpenFileBatches = [];

ipcRenderer.on('cyannota:open-files', (_event, items) => {
  if (!Array.isArray(items) || !items.length) return;
  if (!openFileListeners.size) {
    pendingOpenFileBatches.push(items);
    return;
  }
  openFileListeners.forEach((listener) => listener(items));
});

contextBridge.exposeInMainWorld('cyAnnotaDesktop', {
  chooseSaveFile: ({ name }) =>
    ipcRenderer.invoke('cyannota:choose-save-file', { name }),
  readClipboardFiles: () =>
    ipcRenderer.invoke('cyannota:read-clipboard-files'),
  beginSaveFile: ({ token }) =>
    ipcRenderer.invoke('cyannota:begin-save-file', { token }),
  writeSaveChunk: ({ token, base64 }) =>
    ipcRenderer.invoke('cyannota:write-save-chunk', { token, base64 }),
  finishSaveFile: ({ token, copyToClipboard }) =>
    ipcRenderer.invoke('cyannota:finish-save-file', { token, copyToClipboard }),
  abortSaveFile: ({ token }) =>
    ipcRenderer.invoke('cyannota:abort-save-file', { token }),
  showErrorMessage: ({ title, message, detail }) =>
    ipcRenderer.invoke('cyannota:show-error-message', { title, message, detail }),
  onOpenFiles: (callback) => {
    if (typeof callback !== 'function') return () => undefined;
    openFileListeners.add(callback);
    while (pendingOpenFileBatches.length) callback(pendingOpenFileBatches.shift());
    return () => openFileListeners.delete(callback);
  },
});
