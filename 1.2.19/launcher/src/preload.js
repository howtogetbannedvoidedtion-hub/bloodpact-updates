const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bloodpact', {
  getState: () => ipcRenderer.invoke('launcher:get-state'),
  selectProfile: (profileId) => ipcRenderer.invoke('launcher:select-profile', profileId),
  syncMods: () => ipcRenderer.invoke('launcher:sync-mods'),
  toggleMod: (modId, enabled) => ipcRenderer.invoke('launcher:toggle-mod', modId, enabled),
  saveSettings: (settings) => ipcRenderer.invoke('launcher:save-settings', settings),
  play: (username) => ipcRenderer.invoke('launcher:play', username),
  searchModrinth: (query) => ipcRenderer.invoke('launcher:search-modrinth', query),
  searchMods: (source, query) => ipcRenderer.invoke('launcher:search-mods', source, query),
  installCustomMod: (source, id) => ipcRenderer.invoke('launcher:install-custom-mod', source, id),
  removeCustomMod: (modId) => ipcRenderer.invoke('launcher:remove-custom-mod', modId),
  toggleCustomMod: (modId, enabled) => ipcRenderer.invoke('launcher:toggle-custom-mod', modId, enabled),
  openExternal: (url) => ipcRenderer.invoke('launcher:open-external', url),
  checkUpdates: () => ipcRenderer.invoke('launcher:check-updates'),
  applyUpdates: () => ipcRenderer.invoke('launcher:apply-updates'),
  selectOpSeed: (seedId) => ipcRenderer.invoke('launcher:select-op-seed', seedId),
  setCustomOpSeed: (seedValue) => ipcRenderer.invoke('launcher:set-custom-op-seed', seedValue),
  clearOpSeed: () => ipcRenderer.invoke('launcher:clear-op-seed'),
  openCrashLog: () => ipcRenderer.invoke('launcher:open-crash-log'),
  getCrashLog: () => ipcRenderer.invoke('launcher:get-crash-log')
});
