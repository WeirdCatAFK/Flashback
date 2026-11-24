const VAULT_SCOPED_KEYS = new Set([
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

/** useConnection calls this before React renders the new vault, so views read that vault's prefs. A new vault inherits the global value of a scoped key. */
export function setActiveVaultScope(vaultId) {
  activeVaultId = vaultId || null;
}

function prefKey(key) {
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
