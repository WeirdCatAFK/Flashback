import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('flashback', {
  getApiUrl: () => ipcRenderer.invoke('get-api-url')
})
