const bridge = () => window.flashback ?? null;

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
export const onUpdateStatus = (handler) => bridge()?.onUpdateStatus?.(handler);

export const windowMinimize = () => bridge()?.windowMinimize?.();
export const windowMaximize = () => bridge()?.windowMaximize?.();
export const windowClose = () => bridge()?.windowClose?.();

export const completeSetup = (config) => call("completeSetup", config);

export const isSetupPreview = async () => !!(await bridge()?.isSetupPreview?.());

export const onFlashbackNavigate = (handler) =>
  bridge()?.onFlashbackNavigate?.(handler);
