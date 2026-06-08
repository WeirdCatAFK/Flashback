const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flashback', {
  getApiUrl:       ()       => ipcRenderer.invoke('get-api-url'),
  getConfig:       ()       => ipcRenderer.invoke('get-config'),
  setConfig:       (config) => ipcRenderer.invoke('set-config', config),
  restartApp:      ()       => ipcRenderer.invoke('restart-app'),
  isFirstRun:      ()       => ipcRenderer.invoke('is-first-run'),
  completeSetup:   (config) => ipcRenderer.invoke('complete-setup', config),
  getUserDataPath: ()       => ipcRenderer.invoke('get-user-data-path'),
  windowMinimize:  ()       => ipcRenderer.send('window-minimize'),
  windowMaximize:  ()       => ipcRenderer.send('window-maximize'),
  windowClose:     ()       => ipcRenderer.send('window-close'),
})
