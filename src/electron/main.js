// src/electron/main.js
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { isDev } from "./utils.js";
import spawn from './api_process.js';

// Reconstruct __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let tray;
let isQuitting = false;

// Helper to get the icon path correctly in both Dev and Prod
function getIconPath() {
  // flashback.ico is in the root
  return path.join(__dirname, "../../flashback.ico");
}

function createTray() {
  const icon = nativeImage.createFromPath(getIconPath());
  tray = new Tray(icon);
  tray.setToolTip('Flashback API is running');

  const contextMenu = Menu.buildFromTemplate([
    { 
      label: 'Open Flashback', 
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      } 
    },
    { type: 'separator' },
    { 
      label: 'Quit', 
      click: () => {
        isQuitting = true;
        app.quit();
      } 
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Optional: Double-clicking the tray icon opens the app
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: getIconPath()
  });

  // Load content
  if (isDev()) {
    mainWindow.loadURL("http://localhost:51234");
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile("dist-react/index.html");
  }

  // --- TRAY MODE LOGIC ---
  // Intercept the close event. 
  // If the user clicks 'X', hide the window but keep the app (and API) running.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
    // If isQuitting is true, let the event propagate and close the window/app
  });
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
  } catch {
    return { port: 50500, host: 'localhost', isLocalhost: true, isCustomPath: false, customPath: '', logFormat: 'dev', vaultName: 'default' };
  }
}

// IPC: window controls (custom title bar)
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close',    () => mainWindow?.close());

// IPC: renderer asks for the API base URL once on startup
ipcMain.handle('get-api-url', () => {
  const config = readConfig();
  return `http://${config.host ?? 'localhost'}:${config.port ?? 50500}`;
});

// IPC: renderer reads the full config object
ipcMain.handle('get-config', () => readConfig());

// IPC: renderer writes a new config object
ipcMain.handle('set-config', (_event, newConfig) => {
  try {
    const oldConfig = readConfig();
    fs.writeFileSync(getConfigPath(), JSON.stringify(newConfig, null, 2));

    // Rename the vault folder on disk when vaultName changes
    if (!newConfig.isCustomPath && !oldConfig.isCustomPath) {
      const oldVault = oldConfig.vaultName || 'default';
      const newVault = newConfig.vaultName || 'default';
      if (oldVault !== newVault) {
        const userData = app.getPath('userData');
        const oldPath = path.join(userData, oldVault);
        const newPath = path.join(userData, newVault);
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        }
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// IPC: renderer requests a full app restart
ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.exit(0);
});

// Single Instance Lock (Recommended)
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("ready", () => {
    spawn(); // Starts your API
    createTray(); // Creates the Tray Icon
    createWindow(); // Creates the UI
  });

  // MacOS Dock click behavior
  app.on("activate", () => {
    if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
    }
  });
}

// Handle explicit quit request
app.on('before-quit', () => {
  isQuitting = true;
});