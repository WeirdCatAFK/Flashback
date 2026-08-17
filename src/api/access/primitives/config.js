import path from "path";
import fs from "fs";
import defaultConfig from "../../config/defaults/ConfigJSON.js";

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
 * the api token and the remotes) and this module — so the cache goes stale whenever main
 * writes. Every path resolver below is a pure per-call function over get(), which is what
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

function _baseDir() {
    return process.env.USER_DATA_PATH || path.join(process.cwd(), "data");
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
// existing consumer of those fields — getVaultPath() above, the Seal commit author, the
// diary's author, the `createdBy` stamp on new sidecars — keeps working untouched, and a
// config.json written by an older build still opens. The registry is purely additive.
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
