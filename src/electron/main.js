// src/electron/main.js
import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } from "electron";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { isDev } from "./utils.js";
import spawn, { killApi } from './api_process.js';
import log, { getLogPath } from "./logger.js";
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from "./updater.js";
import { configExists, readConfig, writeConfig, apiBaseUrl } from "./appConfig.js";
import * as vaults from "./vaults.js";
import { createConnectionState } from "./connection.js";
import { getStoredIdentity, setIdentity, setVaultIdentity } from "./identity.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.on("uncaughtException", (err) => {
  log.error("Uncaught exception in main process:", err);
  try {
    dialog.showErrorBox(
      "Flashback encountered an error",
      `${err?.stack || err}\n\nA log was written to:\n${getLogPath()}`,
    );
  } catch { }
});
process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection in main process:", reason);
});

let forceOnboarding = process.argv.includes('--onboarding');

let mainWindow;
let tray;
let isQuitting = false;

/** Absolute path of the tray and window icon for this platform. */
function getIconPath(ext = process.platform === 'win32' ? 'ico' : 'png') {
  const file = `flashback.${ext}`;
  return app.isPackaged
    ? path.join(process.resourcesPath, file)
    : path.join(__dirname, '../../', file);
}

/** Builds the system tray icon and its menu; Quit is the only exit. */
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

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/** Creates the frameless main window and wires its close-to-tray behaviour. */
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

  if (isDev()) {
    mainWindow.loadURL("http://localhost:51234");
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile("dist-react/index.html");
  }

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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('flashback://')) {
      mainWindow.webContents.send('flashback-navigate', url.slice('flashback://'.length));
    } else if (/^(https?|mailto):/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && !isFirstRun()) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  initUpdater(mainWindow, { isPackaged: app.isPackaged });
}

/** True when no config.json exists, or when --onboarding was passed. */
function isFirstRun() {
  return forceOnboarding || !configExists();
}

/** Mints and persists the API token if config.json has none; main is its sole minter. */
function ensureApiToken() {
  if (!configExists()) return null;
  const config = readConfig();
  if (!config.apiToken) {
    config.apiToken = crypto.randomBytes(32).toString('hex');
    try {
      writeConfig(config);
    } catch (err) {
      console.error('Failed to persist API token:', err);
    }
  }
  return config.apiToken;
}

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('window-close',    () => mainWindow?.close());

ipcMain.handle('get-api-url', () => {
  const config = readConfig();
  return `http://${config.host ?? 'localhost'}:${config.port ?? 50500}`;
});

ipcMain.handle('get-api-token', () => readConfig().apiToken ?? null);

ipcMain.handle('is-first-run', () => isFirstRun());

ipcMain.handle('complete-setup', (_event, config) => {
  try {
    if (!config.apiToken) config.apiToken = crypto.randomBytes(32).toString('hex');
    writeConfig(config);
    vaults.ensureRegistry();
    forceOnboarding = false;
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try { spawn(); }       catch (err) { console.error('API spawn error:', err); }
  try { createTray(); }  catch (err) { console.error('Tray error:', err); }
  return { ok: true };
});

ipcMain.handle('get-config', () => readConfig());

const RENDERER_WRITABLE_FIELDS = [
  'port', 'host', 'logFormat', 'isLocalhost', 'mcpDiaryAccess',
];

ipcMain.handle('set-config', (_event, newConfig) => {
  try {
    const merged = readConfig();
    for (const key of RENDERER_WRITABLE_FIELDS) {
      if (newConfig && key in newConfig) merged[key] = newConfig[key];
    }
    writeConfig(merged);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('list-vaults', () => vaults.listVaults());

ipcMain.handle('create-vault', (_event, name) => vaults.createVault(name));

ipcMain.handle('remove-vault', (_event, id) => vaults.removeVault(id));

ipcMain.handle('rename-vault', async (_event, id, name) => {
  const result = await vaults.renameVault(id, name);
  if (result.ok) broadcastConnection();
  return result;
});

ipcMain.handle('switch-vault', async (_event, id) => {
  const result = await vaults.switchVault(id);
  if (result.ok) {
    connection.useLocalVault();
    broadcastConnection();
  }
  return result;
});

ipcMain.handle('open-vault-from-disk', async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a Flashback vault',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths?.length) return { ok: false, canceled: true };
  return vaults.adoptVault(picked.filePaths[0]);
});

ipcMain.handle('get-identity', () => getStoredIdentity());

ipcMain.handle('set-identity', (_event, identity) => setIdentity(identity ?? {}));

ipcMain.handle('set-vault-identity', (_event, vaultId, identity) =>
    setVaultIdentity(vaultId ?? readConfig().activeVaultId, identity ?? null));

ipcMain.handle('list-remotes', () => vaults.listRemotes());
ipcMain.handle('add-remote', (_event, remote) => vaults.addRemote(remote ?? {}));
ipcMain.handle('remove-remote', (_event, id) => vaults.removeRemote(id));
ipcMain.handle('test-remote', (_event, id) => vaults.testRemote(id));

const connection = createConnectionState({
  readConfig,
  connectionForRemote: vaults.connectionForRemote,
  apiBaseUrl,
});

/** Where the renderer is currently pointed: the local vault, or a remote with its decrypted token. */
function currentConnection() {
  return connection.current();
}

/** Pushes the current connection to the renderer over IPC. */
function broadcastConnection() {
  mainWindow?.webContents.send('connection-changed', currentConnection());
}

ipcMain.handle('get-active-connection', () => currentConnection());

ipcMain.handle('use-local-vault', () => {
  connection.useLocalVault();
  broadcastConnection();
  return { ok: true, connection: currentConnection() };
});

ipcMain.handle('use-remote', async (_event, id) => {
  const probe = await vaults.testRemote(id);
  if (!probe.ok) return probe;

  connection.useRemote(id);
  broadcastConnection();
  return { ok: true, connection: currentConnection(), identity: probe.identity };
});

ipcMain.handle('restart-app', () => {
  killApi();
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.on('renderer-error', (_event, payload) => {
  log.error('[renderer]', payload);
});

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

/** The .mcp.json snippet shown in Config, with FLASHBACK_API_TOKEN injected. */
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

ipcMain.handle('get-mcp-config', () => {
  const flashback = getMcpServerConfig();
  return {
    isPackaged: app.isPackaged,
    serverPath: flashback.args[0],
    json: JSON.stringify({ mcpServers: { flashback } }, null, 2),
  };
});

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
      ensureApiToken();
      vaults.ensureRegistry();
      spawn();
      createTray();
    }
    createWindow();
  });

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isVisible()) {
        mainWindow.show();
    }
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  killApi();
});