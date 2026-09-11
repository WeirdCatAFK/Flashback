import path from "path";
import fs from "fs";
import os from "os";
import defaultConfig from "../../config/defaults/ConfigJSON.js";
import { defaultIdentityFrom } from "../../../shared/identity.js";

let cache = null;

/** Absolute path of config.json. */
function getConfigPath() {
    if (process.env.USER_DATA_PATH) {
        return path.join(process.env.USER_DATA_PATH, "config.json");
    }
    if (process.versions.electron) throw new Error("USER_DATA_PATH env var is not set");
    return path.join(process.cwd(), "data", "config.json");
}

/** The parsed config, cached until `reload()`. */
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

/** Drops the cached config so the next get() re-reads from disk. */
export function reload() {
    cache = null;
}

/** Reads config.json straight off disk, bypassing the cache. */
function readFresh() {
    try {
        return JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    } catch {
        return null;
    }
}

/** The install's data directory — where `config.json` lives, and the parent of every vault. */
export function getBaseDir() {
    return process.env.USER_DATA_PATH || path.join(process.cwd(), "data");
}

function _baseDir() {
    return getBaseDir();
}

/** Absolute path of the active vault directory. */
export function getVaultPath() {
    const config = get();
    const vaultName = config.vaultName || "default";
    if (config.isCustomPath) {
        if (!path.isAbsolute(config.customPath)) throw new Error("Custom path provided is not absolute");
        return path.join(config.customPath, vaultName);
    }
    return path.join(_baseDir(), vaultName);
}

/**
 * An explicitly configured root, or null when the vault's own layout should be used.
 *
 * A server deployment can put the canonical files and the derived index on their own mounts,
 * so that each volume has ONE answer to "can I lose this?" — the workspace is authorial and
 * irreplaceable, the index is rebuildable and disposable. Both default to null, which is what
 * keeps the desktop app and every existing deployment on the layout they already have.
 *
 * Absolute only. A relative override would resolve against whatever the process happened to be
 * started from, which for a container is an implementation detail of the image.
 *
 * @param {string|undefined} value
 * @param {string} field
 * @returns {string|null}
 */
function explicitRoot(value, field) {
    if (typeof value !== "string" || value.trim() === "") return null;
    const root = value.trim();
    if (!path.isAbsolute(root)) {
        throw new Error(`config.${field} must be an absolute path, got "${root}"`);
    }
    return root;
}

/**
 * Absolute path of the active vault's `workspace/` — the canonical, git-versioned layer.
 *
 * `workspacePath` overrides it wholesale: the configured directory IS the workspace, not a
 * parent to append `workspace/` to. Seal's repo root, `Files.workspaceRoot` and `mcpReader`
 * all resolve through here, so one override moves the whole canonical layer.
 */
export function getWorkspacePath() {
    return explicitRoot(get()?.workspacePath, "workspacePath")
        ?? path.join(getVaultPath(), "workspace");
}

/**
 * Absolute path of the active vault's SQLite database — the derived index.
 *
 * `indexPath` names a DIRECTORY to hold it, not the file: the filename stays `{vaultName}.db`
 * so a vault renamed on disk still lines up. This is the one store a deployment may put on
 * throwaway storage, which only became true once every behavioural table moved to the progress
 * store (migrations 013-016).
 */
export function getDatabasePath() {
    const config = get();
    const vaultName = config.vaultName || "default";
    const root = explicitRoot(config?.indexPath, "indexPath");
    return path.join(root ?? getVaultPath(), `${vaultName}.db`);
}

/**
 * Absolute path of the active vault's progress store.
 *
 * A sibling of `workspace/`, not a child: inside the vault so it travels with a copied
 * folder, outside the workspace so Seal never versions it. See `primitives/progress.js`.
 *
 * @returns {string}
 */
export function getProgressDatabasePath() {
    return path.join(getVaultPath(), "progress.db");
}

/** How much of the diary the MCP server may read, read fresh from disk. */
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

export const CARD_REMOVAL_DEFAULTS = { perHour: 20, perRequest: 10 };

/** The per-request and per-hour card-removal budget. */
export function getCardRemovalLimits() {
    const positiveInt = (v, fallback) =>
        Number.isInteger(v) && v >= 0 ? v : fallback;
    try {
        const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
        return {
            perHour: positiveInt(cfg.cardRemovalsPerHour, CARD_REMOVAL_DEFAULTS.perHour),
            perRequest: positiveInt(cfg.cardRemovalsPerRequest, CARD_REMOVAL_DEFAULTS.perRequest),
        };
    } catch {
        return { ...CARD_REMOVAL_DEFAULTS };
    }
}

/**
 * The registered vaults.
 *
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
 * Points the config at a different vault and drops the cache, so every path resolver in this module answers for the new vault on its next call.
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
 * Extra browser origins allowed to reach this API, on top of the ones config/cors.js derives for itself.
 *
 * @returns {string[]}
 */
export function getAllowedOrigins() {
    const origins = get()?.allowedOrigins;
    return Array.isArray(origins) ? origins.filter((o) => typeof o === "string" && o) : [];
}

/**
 * Whether this install may fetch a user-supplied URL that resolves onto a private network.
 *
 * @returns {boolean}
 */
export function getAllowPrivateNetworkFetch() {
    return get()?.allowPrivateNetworkFetch === true;
}

/** A {name, email} pair only counts if BOTH halves are present — half-filled is not set. */
function usable(identity) {
    const name = typeof identity?.name === "string" ? identity.name.trim() : "";
    const email = typeof identity?.email === "string" ? identity.email.trim() : "";
    return name && email ? { name, email } : null;
}

/** Falls back to the OS account. */
function derivedIdentity() {
    let username = "";
    try {
        username = os.userInfo().username || "";
    } catch { }
    return defaultIdentityFrom(username);
}

/**
 * The identity to stamp on work done in the active vault.
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
 * @returns {string}
 */
export function getAuthorString() {
    const { name, email } = getIdentity();
    return `${name} <${email}>`;
}

/** Merges fields into config.json and drops the cache. */
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
