const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flashback', {
  getApiUrl:  ()       => ipcRenderer.invoke('get-api-url'),
  getConfig:  ()       => ipcRenderer.invoke('get-config'),
  setConfig:  (config) => ipcRenderer.invoke('set-config', config),
})
