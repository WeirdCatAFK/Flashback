const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flashback', {
  getApiUrl:       ()       => ipcRenderer.invoke('get-api-url'),
  getConfig:       ()       => ipcRenderer.invoke('get-config'),
  setConfig:       (config) => ipcRenderer.invoke('set-config', config),
  restartApp:      ()       => ipcRenderer.invoke('restart-app'),
  isFirstRun:      ()       => ipcRenderer.invoke('is-first-run'),
  completeSetup:   (config) => ipcRenderer.invoke('complete-setup', config),
  getUserDataPath: ()       => ipcRenderer.invoke('get-user-data-path'),
  getMcpConfig:    ()       => ipcRenderer.invoke('get-mcp-config'),
  windowMinimize:  ()       => ipcRenderer.send('window-minimize'),
  windowMaximize:  ()       => ipcRenderer.send('window-maximize'),
  windowClose:     ()       => ipcRenderer.send('window-close'),
  // Fallback for flashback:// links that reach Electron's will-navigate handler
  // (shouldn't happen with onClickCapture, but kept as safety net).
  onFlashbackNavigate: (cb) => {
    const listener = (_event, hash) => cb(hash);
    ipcRenderer.on('flashback-navigate', listener);
    return () => ipcRenderer.removeListener('flashback-navigate', listener);
  },
})
