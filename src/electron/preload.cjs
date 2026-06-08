const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flashback', {
  getApiUrl:       ()       => ipcRenderer.invoke('get-api-url'),
  getConfig:       ()       => ipcRenderer.invoke('get-config'),
  setConfig:       (config) => ipcRenderer.invoke('set-config', config),
  restartApp:      ()       => ipcRenderer.invoke('restart-app'),
  windowMinimize:  ()       => ipcRenderer.send('window-minimize'),
  windowMaximize:  ()       => ipcRenderer.send('window-maximize'),
  windowClose:     ()       => ipcRenderer.send('window-close'),
})
