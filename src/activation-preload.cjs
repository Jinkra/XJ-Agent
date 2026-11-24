const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('activation', {
  state: () => ipcRenderer.invoke('activation:state'),
  activate: (code) => ipcRenderer.invoke('activation:submit', code),
});
