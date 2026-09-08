// src/electron/updater.js
// electron-updater in "notify-first" mode: the app checks GitHub Releases for a newer
// version but never downloads or installs on its own. It emits status over the
// 'update-status' IPC; the renderer (Config → About) surfaces a notice with an
// "Update now" action that triggers download + install only on the user's click.
//
// Works with unsigned builds. Post-beta silent updates = flip autoDownload to true.
import electronUpdater from 'electron-updater';
import log from './logger.js';

const { autoUpdater } = electronUpdater;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = log;

const DAY_MS = 24 * 60 * 60 * 1000;
let mainWindow = null;
let wired = false;

/** Streams one updater status object to the renderer. */
function send(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-status', payload);
  }
}

/** Arms the notify-first update check; no-ops unless the app is packaged. */
export function initUpdater(win, { isPackaged }) {
  mainWindow = win;
  if (!isPackaged || wired) return;
  wired = true;

  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info?.version }));
  autoUpdater.on('update-not-available', (info) => send({ state: 'none', version: info?.version }));
  autoUpdater.on('error', (err) => send({ state: 'error', message: String(err?.message || err) }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p?.percent ?? 0) }));
  autoUpdater.on('update-downloaded', (info) => send({ state: 'downloaded', version: info?.version }));

  setTimeout(() => checkForUpdates().catch((e) => log.warn('Startup update check failed:', e)), 8000);
  setInterval(() => checkForUpdates().catch((e) => log.warn('Scheduled update check failed:', e)), DAY_MS);
}

/** Asks GitHub Releases whether a newer version exists. */
export async function checkForUpdates() {
  const result = await autoUpdater.checkForUpdates();
  return result?.updateInfo?.version ?? null;
}

/** Downloads a pending update; only ever called from a user click. */
export async function downloadUpdate() {
  await autoUpdater.downloadUpdate();
}

/** Quits and installs a downloaded update. */
export function quitAndInstall() {
  autoUpdater.quitAndInstall();
}
