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
  // Vault management. The registry lives in the main process; switching happens in the
  // API process, which is the one holding the database handle.
  listVaults:      ()           => ipcRenderer.invoke('list-vaults'),
  createVault:     (name)       => ipcRenderer.invoke('create-vault', name),
  renameVault:     (id, name)   => ipcRenderer.invoke('rename-vault', id, name),
  removeVault:     (id)         => ipcRenderer.invoke('remove-vault', id),
  switchVault:     (id)         => ipcRenderer.invoke('switch-vault', id),
  openVaultFromDisk: ()         => ipcRenderer.invoke('open-vault-from-disk'),
  // Remote Flashback Server instances. Tokens stay in main (encrypted via safeStorage);
  // these calls never return one.
  listRemotes:     ()           => ipcRenderer.invoke('list-remotes'),
  addRemote:       (remote)     => ipcRenderer.invoke('add-remote', remote),
  removeRemote:    (id)         => ipcRenderer.invoke('remove-remote', id),
  testRemote:      (id)         => ipcRenderer.invoke('test-remote', id),
  // The active connection — local vault or remote server, same {url, token} shape.
  getActiveConnection: ()       => ipcRenderer.invoke('get-active-connection'),
  useLocalVault:   ()           => ipcRenderer.invoke('use-local-vault'),
  useRemote:       (id)         => ipcRenderer.invoke('use-remote', id),
  onConnectionChange: (cb)      => {
    const listener = (_event, connection) => cb(connection);
    ipcRenderer.on('connection-changed', listener);
    return () => ipcRenderer.removeListener('connection-changed', listener);
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
