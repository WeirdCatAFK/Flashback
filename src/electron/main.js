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

let forceOnboarding = process.argv.includes('--onboarding');

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

  // Block any Electron-level navigation to flashback:// — these are internal
  // document links that React handles via onClickCapture + IPC; the OS must
  // never see them as protocol URLs.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('flashback://')) {
      event.preventDefault();
      mainWindow.webContents.send('flashback-navigate', url.slice('flashback://'.length));
    }
  });

  // --- TRAY MODE LOGIC ---
  // Intercept the close event. 
  // If the user clicks 'X', hide the window but keep the app (and API) running.
  mainWindow.on('close', (event) => {
    // On first run (no config yet, or --onboarding flag) close normally, don't hide to tray.
    if (!isQuitting && !isFirstRun()) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function configExists() {
  return fs.existsSync(getConfigPath());
}

function isFirstRun() {
  return forceOnboarding || !configExists();
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

// IPC: first-run detection — true when config.json does not yet exist or --onboarding passed
ipcMain.handle('is-first-run', () => isFirstRun());

// IPC: onboarding writes initial config, then starts the API in-process and
// reloads the renderer. Avoids app.relaunch() which would re-pass --onboarding
// and break the npm-run-all dev setup by killing the Vite server on exit.
ipcMain.handle('complete-setup', (_event, config) => {
  try {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
    forceOnboarding = false;
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try { spawn(); }       catch (err) { console.error('API spawn error:', err); }
  try { createTray(); }  catch (err) { console.error('Tray error:', err); }
  return { ok: true };
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

// IPC: renderer reads the app userData path (used for path preview in onboarding)
ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

// Resolves the MCP server config a user should paste into Claude Code's .mcp.json
// or Claude Desktop's claude_desktop_config.json. The server itself (src/mcp/server.js)
// is a plain Node/HTTP client of this app's own API — see src/mcp/ — so all that's
// needed here is telling an MCP host how to launch it and where the API is.
//
// Packaged: the script lives inside app.asar, and end users won't have Node.js
// installed separately, so we point the "command" at this app's own executable
// with ELECTRON_RUN_AS_NODE=1 — Electron's bundled Node runs the script directly
// (and, critically, its asar-aware fs patches mean it can read the script and its
// node_modules straight out of app.asar; a system `node` binary could not).
// Dev: plain `node`, matching what's already verified to work during development.
function getMcpServerConfig() {
  const serverPath = path.join(__dirname, '../mcp/server.js');
  const config = readConfig();
  const apiUrl = `http://${config.host ?? 'localhost'}:${config.port ?? 50500}`;

  if (app.isPackaged) {
    return {
      command: process.execPath,
      args: [serverPath],
      env: { ELECTRON_RUN_AS_NODE: '1', FLASHBACK_API_URL: apiUrl },
    };
  }
  return {
    command: 'node',
    args: [serverPath],
    env: { FLASHBACK_API_URL: apiUrl },
  };
}

// IPC: renderer asks for a ready-to-paste MCP config snippet (Config → AI Assistant)
ipcMain.handle('get-mcp-config', () => {
  const flashback = getMcpServerConfig();
  return {
    isPackaged: app.isPackaged,
    serverPath: flashback.args[0],
    json: JSON.stringify({ mcpServers: { flashback } }, null, 2),
  };
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
    if (!isFirstRun()) {
      spawn();       // API only runs when there's a config to read
      createTray();
    }
    createWindow();
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