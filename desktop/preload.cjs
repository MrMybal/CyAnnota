const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cyAnnotaDesktop', {
  chooseSaveFile: ({ name }) =>
    ipcRenderer.invoke('cyannota:choose-save-file', { name }),
  beginSaveFile: ({ token }) =>
    ipcRenderer.invoke('cyannota:begin-save-file', { token }),
  writeSaveChunk: ({ token, base64 }) =>
    ipcRenderer.invoke('cyannota:write-save-chunk', { token, base64 }),
  finishSaveFile: ({ token }) =>
    ipcRenderer.invoke('cyannota:finish-save-file', { token }),
  abortSaveFile: ({ token }) =>
    ipcRenderer.invoke('cyannota:abort-save-file', { token }),
  showErrorMessage: ({ title, message, detail }) =>
    ipcRenderer.invoke('cyannota:show-error-message', { title, message, detail }),
});