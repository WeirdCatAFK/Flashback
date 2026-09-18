/**
 * The Electron main process as an API: what `window.flashback` (preload.cjs)
 * exposes, wrapped so views never touch the bridge directly and a `dev:web`
 * session without Electron gets a clear error rather than an undefined call.
 * Identity and vault registries have their own modules (identity.js, vaults.js);
 * this covers config, the window, updates and the MCP snippet.
 */

const bridge = () => window.flashback ?? null;

/** Whether the renderer is running inside the desktop app. */
export const isDesktop = () => !!window.flashback;

const missing = () =>
  new Error("window.flashback not available — run via Electron, not dev:web");

const call = (name, ...args) => {
  const b = bridge();
  if (!b || typeof b[name] !== "function") return Promise.reject(missing());
  return b[name](...args);
};

export const getConfig = () => call("getConfig");
export const setConfig = (config) => call("setConfig", config);
export const restartApp = () => bridge()?.restartApp?.();
export const getAppVersion = () => call("getAppVersion");
export const getMcpConfig = () => call("getMcpConfig");
export const getUserDataPath = () => call("getUserDataPath");

export const checkForUpdates = () => call("checkForUpdates");
export const downloadUpdate = () => call("downloadUpdate");
export const installUpdate = () => bridge()?.installUpdate?.();
/** Subscribe to the update-status stream; returns the unsubscribe, or undefined outside Electron. */
export const onUpdateStatus = (handler) => bridge()?.onUpdateStatus?.(handler);

export const windowMinimize = () => bridge()?.windowMinimize?.();
export const windowMaximize = () => bridge()?.windowMaximize?.();
export const windowClose = () => bridge()?.windowClose?.();

/** First run: write config.json and create the first vault; the API is spawned after. */
export const completeSetup = (config) => call("completeSetup", config);

/** Subscribe to `flashback://` links the OS handed to main; returns the unsubscribe, or undefined outside Electron. */
export const onFlashbackNavigate = (handler) =>
  bridge()?.onFlashbackNavigate?.(handler);
