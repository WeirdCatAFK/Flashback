/**
 * Vault-scoped localStorage preferences. Study settings are stored as
 * <key>@<vaultId>, falling back to and copying forward the old global key;
 * cosmetic settings stay global (INTERFACE.md § preferences).
 */

/** Keys that follow the vault. Everything else stays global. */
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

/**
 * null means "no vault id known" — the browser-only dev fallback, or an install whose
 * registry has not been written yet. In that case scoping is a no-op and the global keys
 * are used, which is exactly the pre-existing behaviour.
 */
let activeVaultId = null;

/** Called at bootstrap and on every connection change, before any view reads a pref. */
export function setActiveVaultScope(vaultId) {
  activeVaultId = vaultId || null;
}

export function getActiveVaultScope() {
  return activeVaultId;
}

/** The storage key a preference actually lives under, given the active vault. */
export function prefKey(key) {
  if (!activeVaultId || !VAULT_SCOPED_KEYS.has(key)) return key;
  return `${key}@${activeVaultId}`;
}

/**
 * Reads a preference, migrating it out of the old global key on first access.
 *
 * The migration is one-way and one-time per vault: if the scoped key is absent but the
 * global one is set, the global value is copied to the scoped key and returned. The
 * global key is deliberately LEFT in place — a second vault that has never been opened
 * should inherit the same starting point rather than jump to a hardcoded default.
 *
 * @param {string} key
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
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

/** Convenience for the several call sites that store a boolean as "true"/"false". */
export function getBoolPref(key, fallback = false) {
  const raw = getPref(key);
  return raw === null ? fallback : raw === "true";
}

/** Convenience for numeric prefs; returns `fallback` when unset or unparseable. */
export function getNumberPref(key, fallback) {
  const raw = getPref(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
