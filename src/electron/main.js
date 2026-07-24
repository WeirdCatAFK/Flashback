// src/electron/main.js
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } from "electron";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { isDev } from "./utils.js";
import spawn, { killApi } from './api_process.js';
import log, { getLogPath } from "./logger.js";
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from "./updater.js";

// Reconstruct __dirname for ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Process-level crash handlers: log with a full stack and (for exceptions) show the
// user a dialog pointing at the log file, instead of dying silently in a packaged build.
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception in main process:", err);
  try {
    dialog.showErrorBox(
      "Flashback encountered an error",
      `${err?.stack || err}\n\nA log was written to:\n${getLogPath()}`,
    );
  } catch { /* dialog can be unavailable before app 'ready' — the log line is enough */ }
});
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection in main process:", reason);
});

let forceOnboarding = process.argv.includes('--onboarding');

let mainWindow;
let tray;
let isQuitting = false;

// Resolve an app icon path in both dev and prod. In dev the icons sit in the repo
// root (two levels up from src/electron); once packaged they're copied next to the
// asar via electron-builder's `extraResources`, so they must be read from
// `process.resourcesPath` — reading them from inside the asar fails (they're not in
// `files`), which is why the tray icon was missing in the packaged build.
// Windows renders .ico crisply; the tray on Linux/macOS wants a PNG.
function getIconPath(ext = process.platform === 'win32' ? 'ico' : 'png') {
  const file = `flashback.${ext}`;
  return app.isPackaged
    ? path.join(process.resourcesPath, file)
    : path.join(__dirname, '../../', file);
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

  // True for a real external destination (web article links, YouTube, mailto)
  // that should open in the user's default browser rather than hijacking the
  // single app window. Same-origin http (the Vite dev server / HMR reloads) is
  // left alone so development keeps working; in a packaged build the app is
  // served from file://, so every http(s) link is external.
  const isExternalLink = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'mailto:') return true;
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      const current = mainWindow.webContents.getURL();
      if (current) {
        const cur = new URL(current);
        if ((cur.protocol === 'http:' || cur.protocol === 'https:') && cur.host === u.host) return false;
      }
      return true;
    } catch { return false; }
  };

  // Block any Electron-level navigation to flashback:// — these are internal
  // document links that React handles via onClickCapture + IPC; the OS must
  // never see them as protocol URLs. External web links (clipped articles,
  // video sources) open in the default browser instead of replacing the app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('flashback://')) {
      event.preventDefault();
      mainWindow.webContents.send('flashback-navigate', url.slice('flashback://'.length));
      return;
    }
    if (isExternalLink(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // target="_blank" / window.open (e.g. the clip's source link, YouTube's own
  // in-player links) must never spawn a second Electron window — route real web
  // URLs to the default browser and deny the popup entirely.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('flashback://')) {
      mainWindow.webContents.send('flashback-navigate', url.slice('flashback://'.length));
    } else if (/^(https?|mailto):/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
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

  // Start the notify-first update checker (no-op unless packaged) once the window
  // exists so status events have somewhere to go.
  initUpdater(mainWindow, { isPackaged: app.isPackaged });
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

// The Electron main process owns the API token: it mints one (persisted in
// config.json) if missing, BEFORE spawning the API, so the API process reads an
// already-present token and there is a single writer (no split-brain with the API
// process). Called ahead of every spawn(). Returns the token, or null if config.json
// doesn't exist yet (first run, before onboarding writes it).
function ensureApiToken() {
  if (!configExists()) return null;
  const config = readConfig();
  if (!config.apiToken) {
    config.apiToken = crypto.randomBytes(32).toString('hex');
    try {
      fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
    } catch (err) {
      console.error('Failed to persist API token:', err);
    }
  }
  return config.apiToken;
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

// IPC: renderer asks for the API token once on startup (paired with get-api-url in
// client init). By the time the renderer runs, config.json already holds the token
// (minted by ensureApiToken/complete-setup before the API was spawned).
ipcMain.handle('get-api-token', () => readConfig().apiToken ?? null);

// IPC: first-run detection — true when config.json does not yet exist or --onboarding passed
ipcMain.handle('is-first-run', () => isFirstRun());

// IPC: onboarding writes initial config, then starts the API in-process and
// reloads the renderer. Avoids app.relaunch() which would re-pass --onboarding
// and break the npm-run-all dev setup by killing the Vite server on exit.
ipcMain.handle('complete-setup', (_event, config) => {
  try {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    // Mint the API token into the very first config write so the API process
    // (spawned just below) reads an already-guarded config.
    if (!config.apiToken) config.apiToken = crypto.randomBytes(32).toString('hex');
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
  // app.exit() force-quits without firing before-quit, so kill the API child
  // here to avoid leaving an orphaned server bound to the port across the relaunch.
  killApi();
  app.relaunch();
  app.exit(0);
});

// IPC: renderer reads the app userData path (used for path preview in onboarding)
ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

// IPC: renderer reads the running app version (Config → About)
ipcMain.handle('get-app-version', () => app.getVersion());

// IPC: renderer forwards an uncaught error (window.onerror / unhandledrejection) into
// the shared log file so front-end crashes aren't lost in packaged builds.
ipcMain.on('renderer-error', (_event, payload) => {
  log.error('[renderer]', payload);
});

// IPC: update lifecycle (notify-first). Checks/downloads only run in a packaged build;
// in dev they short-circuit with a friendly message rather than throwing.
ipcMain.handle('updater-check', async () => {
  if (!app.isPackaged) return { ok: false, dev: true, error: 'Updates are only available in the packaged app.' };
  try {
    const version = await checkForUpdates();
    return { ok: true, version };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('updater-download', async () => {
  if (!app.isPackaged) return { ok: false, dev: true, error: 'Updates are only available in the packaged app.' };
  try {
    await downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
});
ipcMain.handle('updater-install', () => {
  if (!app.isPackaged) return { ok: false, dev: true };
  quitAndInstall();
  return { ok: true };
});

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
  const apiToken = config.apiToken ?? '';

  if (app.isPackaged) {
    return {
      command: process.execPath,
      args: [serverPath],
      env: { ELECTRON_RUN_AS_NODE: '1', FLASHBACK_API_URL: apiUrl, FLASHBACK_API_TOKEN: apiToken },
    };
  }
  return {
    command: 'node',
    args: [serverPath],
    env: { FLASHBACK_API_URL: apiUrl, FLASHBACK_API_TOKEN: apiToken },
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
      ensureApiToken(); // mint the token (upgrades from a pre-token install) before the API starts
      spawn();          // API only runs when there's a config to read
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

// Handle explicit quit request. Tear the API utility process down ourselves —
// Electron won't reliably reap it while it holds a listening socket, so leaving
// it to chance is what let the app "not fully close" after Quit.
app.on('before-quit', () => {
  isQuitting = true;
  killApi();
});