import path from "path";
import fs from "fs";
import os from "os";
import defaultConfig from "../../config/defaults/ConfigJSON.js";
import { defaultIdentityFrom } from "../../../shared/identity.js";

let cache = null;

// USER_DATA_PATH wins wherever it is set, Electron or not.
//
// This used to honour the env var only under Electron and fall back to `<cwd>/data`
// otherwise — while _baseDir() below honoured it unconditionally. So a plain-Node process
// with USER_DATA_PATH set (every test file, and `dev:api`) read its config from one place
// and resolved its VAULT relative to another. It went unnoticed because nothing outside
// Electron ever wrote vaultName: every test shared `<cwd>/data/config.json`, read the same
// default vault name out of it, and located its vault correctly by accident.
//
// A vault switch writes vaultName, which turns that split into cross-contamination — one
// test file leaving its active vault in the shared config for the next one to open.
function getConfigPath() {
    if (process.env.USER_DATA_PATH) {
        return path.join(process.env.USER_DATA_PATH, "config.json");
    }
    if (process.versions.electron) throw new Error("USER_DATA_PATH env var is not set");
    return path.join(process.cwd(), "data", "config.json");
}

export function get() {
    if (cache) return cache;

    const configPath = getConfigPath();
    try {
        cache = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        return cache;
    } catch (error) {
        if (error.code === "ENOENT") {
            try {
                fs.mkdirSync(path.dirname(configPath), { recursive: true });
                fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
                cache = { ...defaultConfig };
                return cache;
            } catch (writeErr) {
                console.error("Failed to create config file:", writeErr);
                return false;
            }
        }
        console.error("Unexpected error reading config:", error);
        return false;
    }
}

/**
 * Drops the cached config so the next get() re-reads from disk.
 *
 * config.json has TWO writers — the Electron main process (which owns the vault registry,
 * the api token, the remotes and the user identity) and this module — so the cache goes
 * stale whenever main writes. Dropping it is also what makes a per-vault identity override
 * take effect: getIdentity() reads through get() and has no cache of its own.
 *
 * Every path resolver below is a pure per-call function over get(), which is what
 * makes a vault switch a matter of moving the pointer and calling this, rather than
 * restarting the process.
 */
export function reload() {
    cache = null;
}

/**
 * Reads config.json straight off disk, bypassing the cache.
 *
 * Used by writers that must not clobber a concurrent change from the Electron main
 * process: merge into what is actually on disk, never into a cache that may predate it.
 */
function readFresh() {
    try {
        return JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    } catch {
        return null;
    }
}

/**
 * The install's data directory — where `config.json` lives, and the parent of every vault.
 *
 * Exported because it is not only a step on the way to a vault path any more: the accounts
 * store sits HERE rather than inside a vault, so that copying a vault folder to someone else
 * carries no access list with it.
 */
export function getBaseDir() {
    return process.env.USER_DATA_PATH || path.join(process.cwd(), "data");
}

function _baseDir() {
    return getBaseDir();
}

export function getVaultPath() {
    const config = get();
    const vaultName = config.vaultName || "default";
    if (config.isCustomPath) {
        if (!path.isAbsolute(config.customPath)) throw new Error("Custom path provided is not absolute");
        return path.join(config.customPath, vaultName);
    }
    return path.join(_baseDir(), vaultName);
}

export function getWorkspacePath() {
    return path.join(getVaultPath(), "workspace");
}

export function getDatabasePath() {
    const config = get();
    const vaultName = config.vaultName || "default";
    return path.join(getVaultPath(), `${vaultName}.db`);
}

// How much of the diary AI assistants reaching the API through the MCP server may
// read. Three levels: 'none' (closed), 'summaries' (machine-derived study summaries
// only — the personal written entries stay private), 'full' (summaries + entries).
// Authorization boundary for a SEPARATE process, so it lives in config.json (like
// apiToken) — not a renderer localStorage pref. Read FRESH from disk (bypassing the
// module cache) so toggling it in Config takes effect without an API restart. Fails
// CLOSED: any unrecognized value or read/parse error → 'none'. Default 'none'.
// Back-compat: the flag used to be a boolean (true = full, false = none).
export function getMcpDiaryAccess() {
    try {
        const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
        const v = cfg.mcpDiaryAccess;
        if (v === true || v === "full") return "full";
        if (v === "summaries") return "summaries";
        return "none";
    } catch {
        return "none";
    }
}

// ---------------------------------------------------------------------------
// Vault registry
//
// config.json carries a `vaults[]` registry and an `activeVaultId` pointer, but it ALSO
// keeps the original flat `vaultName`/`isCustomPath`/`customPath` fields as the projection
// of whichever vault is active. That redundancy is deliberate and load-bearing: every
// existing consumer of those fields — getVaultPath() above, getDatabasePath(), the diary's
// storage root — keeps working untouched, and a config.json written by an older build
// still opens. The registry is purely additive.
//
// Authorship is NOT one of those consumers any more: the Seal commit author and the
// `createdBy` stamp read getIdentity() below. The vault is a place; those want a person.
// ---------------------------------------------------------------------------

/**
 * The registered vaults. Synthesizes a single-entry registry from the flat fields when
 * `vaults[]` is absent, which is what an install predating the registry looks like — so
 * callers never have to special-case the un-migrated shape.
 * @returns {Array<{id: string|null, name: string, isCustomPath: boolean, customPath: string}>}
 */
export function getVaults() {
    const config = get() || {};
    if (Array.isArray(config.vaults) && config.vaults.length) return config.vaults;
    return [{
        id: config.activeVaultId ?? null,
        name: config.vaultName || "default",
        isCustomPath: !!config.isCustomPath,
        customPath: config.customPath || "",
    }];
}

/** @returns {string|null} id of the active vault, or null on an un-migrated config. */
export function getActiveVaultId() {
    return get()?.activeVaultId ?? null;
}

/**
 * Points the config at a different vault and drops the cache, so every path resolver in
 * this module answers for the new vault on its next call.
 *
 * Writes the flat projection AND the pointer together — they must never disagree, since
 * the flat fields are what actually resolve paths. Merges into a fresh disk read so a
 * registry entry Electron main added moments ago is not lost.
 *
 * This only moves the pointer. Closing the old database, quiescing Seal and re-running
 * validation are the caller's job — see src/api/vaultSession.js, which is the only thing
 * that should call this.
 *
 * @param {{id: string, name: string, isCustomPath?: boolean, customPath?: string}} entry
 * @returns {boolean}
 */
export function setActiveVault(entry) {
    const onDisk = readFresh();
    if (!onDisk) return false;

    const next = {
        ...onDisk,
        activeVaultId: entry.id,
        vaultName: entry.name,
        isCustomPath: !!entry.isCustomPath,
        customPath: entry.customPath || "",
    };
    return set(next);
}

/**
 * Registered remote Flashback Server instances, with credentials stripped.
 *
 * A remote's token is never stored here — Electron main holds it encrypted via safeStorage
 * — so this is safe to hand to any authenticated caller. `hasToken` is the only thing said
 * about the credential.
 *
 * @returns {Array<{id: string, label: string, url: string, hasToken: boolean}>}
 */
export function getRemotes() {
    const remotes = get()?.remotes;
    if (!Array.isArray(remotes)) return [];
    return remotes.map((r) => ({
        id: r.id,
        label: r.label || r.url,
        url: r.url,
        hasToken: !!r.hasToken,
    }));
}

/**
 * Extra browser origins allowed to reach this API, on top of the ones config/cors.js
 * derives for itself. Empty on a normal desktop install; this is the field a Flashback
 * Server deployment sets to name its own web client.
 * @returns {string[]}
 */
export function getAllowedOrigins() {
    const origins = get()?.allowedOrigins;
    return Array.isArray(origins) ? origins.filter((o) => typeof o === "string" && o) : [];
}

// ---------------------------------------------------------------------------
// Local user identity
//
// Who is using this install, in git's terms: a self-asserted name and email under a single
// `user` key, plus an optional per-vault override keyed by vault id. It mirrors
// `git config --global user.email` against a repo-local one, and it is deliberately NOT
// authentication — nothing validates it and nothing gates on it. When remotes arrive they
// authenticate with access tokens; a server must treat everything here as client-asserted.
//
// The override lives under `user`, not on the vaults[] registry entry, because "which
// address I use where" is a fact about the person. It must also not travel with a copied
// vault folder to someone else's machine — config.json stays behind, vault.json would not.
//
// Read through get(), which reload() already clears on every vault switch, so the override
// follows the active vault by the same mechanism the path resolvers use.
// ---------------------------------------------------------------------------

/** A {name, email} pair only counts if BOTH halves are present — half-filled is not set. */
function usable(identity) {
    const name = typeof identity?.name === "string" ? identity.name.trim() : "";
    const email = typeof identity?.email === "string" ? identity.email.trim() : "";
    return name && email ? { name, email } : null;
}

/**
 * Falls back to the OS account. Unlike git we cannot refuse to write a file for want of an
 * identity, so there is always an answer.
 *
 * Shaped by the shared helper rather than here, because the setup wizard pre-fills its
 * identity step from the same rule via the Electron host — the address it offers and the
 * one that would be stamped if the user skipped the step must be the same string.
 */
function derivedIdentity() {
    let username = "";
    try {
        username = os.userInfo().username || "";
    } catch { /* no OS user info (some sandboxes) — the helper's own fallback stands */ }
    return defaultIdentityFrom(username);
}

/**
 * The identity to stamp on work done in the active vault.
 *
 * Precedence: this vault's override → the global identity → derived from the OS account.
 *
 * @returns {{name: string, email: string, source: "vault"|"global"|"default"}}
 */
export function getIdentity() {
    const user = get()?.user;
    const vaultId = getActiveVaultId();

    if (vaultId && user?.perVault) {
        const override = usable(user.perVault[vaultId]);
        if (override) return { ...override, source: "vault" };
    }

    const global = usable(user);
    if (global) return { ...global, source: "global" };

    return { ...derivedIdentity(), source: "default" };
}

/**
 * The same identity as one string: `Name <email>`.
 *
 * This is what a sidecar's `createdBy` records and what a git author line looks like, and
 * they are deliberately the same value — a file and the commit that created it should not
 * disagree about who made them.
 *
 * @returns {string}
 */
export function getAuthorString() {
    const { name, email } = getIdentity();
    return `${name} <${email}>`;
}

export function set(config) {
    const configPath = getConfigPath();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        cache = config;
        return true;
    } catch (error) {
        console.error("Error writing config file:", error);
        return false;
    }
}
