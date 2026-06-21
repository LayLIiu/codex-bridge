const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  start: (url) => ipcRenderer.invoke('bridge:start', url),
  stop: () => ipcRenderer.invoke('bridge:stop'),
  onLog: (cb) => ipcRenderer.on('bridge:log', (_, data) => cb(data)),
  onStopped: (cb) => ipcRenderer.on('bridge:stopped', (_, data) => cb(data)),
});
