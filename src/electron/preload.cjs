const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flashback', {
  getApiUrl:       ()       => ipcRenderer.invoke('get-api-url'),
  getApiToken:     ()       => ipcRenderer.invoke('get-api-token'),
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
  // App version + notify-first updates (Config → About)
  getAppVersion:   ()       => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: ()       => ipcRenderer.invoke('updater-check'),
  downloadUpdate:  ()       => ipcRenderer.invoke('updater-download'),
  installUpdate:   ()       => ipcRenderer.invoke('updater-install'),
  onUpdateStatus:  (cb)     => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
  // Forward a renderer crash into the main-process log file
  logRendererError: (payload) => ipcRenderer.send('renderer-error', payload),
  // Fallback for flashback:// links that reach Electron's will-navigate handler
  // (shouldn't happen with onClickCapture, but kept as safety net).
  onFlashbackNavigate: (cb) => {
    const listener = (_event, hash) => cb(hash);
    ipcRenderer.on('flashback-navigate', listener);
    return () => ipcRenderer.removeListener('flashback-navigate', listener);
  },
})
