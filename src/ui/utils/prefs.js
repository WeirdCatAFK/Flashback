export const VAULT_SCOPED_KEYS = new Set([
  "fb-srs-algorithm",
  "fb-srs-max-new",
  "fb-fsrs-retention",
  "fb-trainer-order",
  "fb-trainer-scope",
  "fb-trainer-read-only",
  "fb-trainer-batch",
  "fb-diary-enabled",
  "fb-open-folders",
]);

let activeVaultId = null;

export function setActiveVaultScope(vaultId) {
  activeVaultId = vaultId || null;
}

export function getActiveVaultScope() {
  return activeVaultId;
}

export function prefKey(key) {
  if (!activeVaultId || !VAULT_SCOPED_KEYS.has(key)) return key;
  return `${key}@${activeVaultId}`;
}

export function getPref(key, fallback = null) {
  const scoped = prefKey(key);
  const direct = localStorage.getItem(scoped);
  if (direct !== null) return direct;

  if (scoped !== key) {
    const inherited = localStorage.getItem(key);
    if (inherited !== null) {
      localStorage.setItem(scoped, inherited);
      return inherited;
    }
  }
  return fallback;
}

export function setPref(key, value) {
  localStorage.setItem(prefKey(key), String(value));
}

export function removePref(key) {
  localStorage.removeItem(prefKey(key));
}

export function getBoolPref(key, fallback = false) {
  const raw = getPref(key);
  return raw === null ? fallback : raw === "true";
}

export function getNumberPref(key, fallback) {
  const raw = getPref(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
