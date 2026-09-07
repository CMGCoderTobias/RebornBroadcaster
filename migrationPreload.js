const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rebornMigration', {
  onStatus: (callback) => ipcRenderer.on('migration-status', (_event, status) => callback(status)),
  retry: () => ipcRenderer.send('migration-retry'),
  continueLegacy: () => ipcRenderer.send('migration-continue-legacy'),
});
