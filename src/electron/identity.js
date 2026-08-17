// The local user identity, main-process side.
//
// config.json has two writers split by ownership — main owns `apiToken`, `vaults[]`,
// `remotes[]` and now `user`; the API process owns only the active-vault pointer. So this
// is the only place `user` is written, and every write goes through updateConfig(), which
// merges into a fresh read rather than a held copy.
//
// Reading is deliberately RAW here: this returns what is stored, not what would be
// stamped. Resolution (override → global → derived from the OS account) lives in the API's
// config.js and is served by GET /api/identity, so there is one precedence rule rather
// than two that drift. The renderer uses this for the form's current values and that for
// the "currently stamping as" line.

import os from "os";
import { readConfig, updateConfig } from "./appConfig.js";
import { identityError, defaultIdentityFrom } from "../shared/identity.js";

/**
 * What to offer someone who has set nothing — the setup wizard's pre-fill.
 *
 * Shaped by the same shared helper the API's resolver falls back to, so the address the
 * wizard suggests is exactly the one that would be stamped if the step were skipped.
 * Derived here rather than fetched because setup runs BEFORE the API process exists.
 */
export function suggestedIdentity() {
    let username = "";
    try {
        username = os.userInfo().username || "";
    } catch { /* no OS user info — the helper's own fallback stands */ }
    return defaultIdentityFrom(username);
}

/** Keeps only the two fields we store, trimmed. */
function clean(identity) {
    return {
        name: String(identity?.name ?? "").trim(),
        email: String(identity?.email ?? "").trim(),
    };
}

/**
 * What is stored, for the settings form.
 *
 * `suggested` rides along so a caller with nothing stored — the setup wizard, or Config on
 * a fresh install — can show what would be used instead of an empty field.
 *
 * @returns {{user: {name: string, email: string},
 *            override: {name: string, email: string}|null,
 *            suggested: {name: string, email: string},
 *            activeVaultId: string|null}}
 */
export function getStoredIdentity() {
    const config = readConfig();
    const user = config.user ?? {};
    const activeVaultId = config.activeVaultId ?? null;
    const override = activeVaultId ? user.perVault?.[activeVaultId] ?? null : null;

    return {
        user: clean(user),
        override: override ? clean(override) : null,
        suggested: suggestedIdentity(),
        activeVaultId,
    };
}

/**
 * Sets the global identity. Both halves are required together — a name with no address
 * cannot produce an author line, so a half-filled identity is refused rather than stored
 * and silently ignored by the resolver.
 *
 * @param {{name: string, email: string}} identity
 * @returns {{ok: true}|{ok: false, error: string, field?: string, code?: string}}
 */
export function setIdentity(identity) {
    const value = clean(identity);
    const problem = identityError(value);
    if (problem) {
        return { ok: false, error: `Invalid ${problem.field} (${problem.code}).`, ...problem };
    }

    updateConfig((c) => {
        c.user = { ...(c.user ?? {}), name: value.name, email: value.email };
    });
    return { ok: true };
}

/**
 * Sets or clears one vault's identity override.
 *
 * Keyed by vault id rather than by name, so renaming a vault does not orphan its override.
 * Passing null deletes the key outright — an empty object left behind would read as "an
 * override exists" to anything scanning the map.
 *
 * @param {string} vaultId
 * @param {{name: string, email: string}|null} identity
 * @returns {{ok: true}|{ok: false, error: string, field?: string, code?: string}}
 */
export function setVaultIdentity(vaultId, identity) {
    if (!vaultId) return { ok: false, error: "No vault is active, so it has nothing to override." };

    if (identity === null || identity === undefined) {
        updateConfig((c) => {
            if (c.user?.perVault) {
                delete c.user.perVault[vaultId];
                if (!Object.keys(c.user.perVault).length) delete c.user.perVault;
            }
        });
        return { ok: true };
    }

    const value = clean(identity);
    const problem = identityError(value);
    if (problem) {
        return { ok: false, error: `Invalid ${problem.field} (${problem.code}).`, ...problem };
    }

    updateConfig((c) => {
        c.user = c.user ?? {};
        c.user.perVault = c.user.perVault ?? {};
        c.user.perVault[vaultId] = value;
    });
    return { ok: true };
}
