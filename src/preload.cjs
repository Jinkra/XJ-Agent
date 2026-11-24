const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'panel:open', 'pet:menu', 'pet:reveal', 'pet:interactive', 'pet:pose', 'pet:drag-start', 'pet:drag-end', 'pet:always-on-top', 'pet:approval-reply', 'alerts:dismiss', 'alerts:clear', 'chat:send', 'chat:new', 'chat:interrupt', 'chat:reply', 'folder:choose', 'account:refresh', 'costs:refresh', 'key:save', 'settings:save', 'hooks:install', 'codex:open', 'billing:open', 'hooks:folder', 'app:quit', 'mode:set', 'claude:options', 'claude:sessions', 'claude:resume', 'folder:open', 'codex:options', 'update:check', 'update:notes', 'update:error', 'update:install']);
contextBridge.exposeInMainWorld('jinkra', {
  call: (name, value) => { if (!allowed.has(name)) return Promise.reject(new Error('操作不受支持。')); return ipcRenderer.invoke(name, value); },
  motion: callback => ipcRenderer.on('pet-motion', (_, pose) => callback(pose)),
  updateProgress: callback => { const fn = (_, progress) => callback(progress); ipcRenderer.on('update-progress', fn); return () => ipcRenderer.removeListener('update-progress', fn); },
  subscribe: callback => { const fn = (_, state) => callback(state); ipcRenderer.on('state', fn); return () => ipcRenderer.removeListener('state', fn); },
});
