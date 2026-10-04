const { contextBridge, ipcRenderer } = require('electron');

const authApi = {
  minimize: () => ipcRenderer.send('auth-window:minimize'),
  close: () => ipcRenderer.send('auth-window:close'),
  onLoadingChange: (callback) => {
    const listener = (_event, loading) => callback(Boolean(loading));
    ipcRenderer.on('auth-window:loading', listener);
    return () => ipcRenderer.removeListener('auth-window:loading', listener);
  }
};

contextBridge.exposeInMainWorld('nativeAuthWindow', authApi);
