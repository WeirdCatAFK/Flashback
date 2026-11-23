import path from "path";
import fs from "fs";
import os from "os";
import defaultConfig from "../../config/defaults/ConfigJSON.js";
import { defaultIdentityFrom } from "../../../shared/identity.js";

let cache = null;

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

export function reload() {
    cache = null;
}

function readFresh() {
    try {
        return JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
    } catch {
        return null;
    }
}

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

function explicitRoot(value, field) {
    if (typeof value !== "string" || value.trim() === "") return null;
    const root = value.trim();
    if (!path.isAbsolute(root)) {
        throw new Error(`config.${field} must be an absolute path, got "${root}"`);
    }
    return root;
}

export function getWorkspacePath() {
    return explicitRoot(get()?.workspacePath, "workspacePath")
        ?? path.join(getVaultPath(), "workspace");
}

export function getDatabasePath() {
    const config = get();
    const vaultName = config.vaultName || "default";
    const root = explicitRoot(config?.indexPath, "indexPath");
    return path.join(root ?? getVaultPath(), `${vaultName}.db`);
}

export function getProgressDatabasePath() {
    return path.join(getVaultPath(), "progress.db");
}

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

export function getMaxAccounts() {
    try {
        const cfg = JSON.parse(fs.readFileSync(getConfigPath(), "utf-8"));
        const v = cfg.maxAccounts;
        return Number.isInteger(v) && v >= 1 ? v : null;
    } catch {
        return null;
    }
}

export const CARD_REMOVAL_DEFAULTS = { perHour: 20, perRequest: 10 };

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

export function getActiveVaultId() {
    return get()?.activeVaultId ?? null;
}

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

export function getAllowedOrigins() {
    const origins = get()?.allowedOrigins;
    return Array.isArray(origins) ? origins.filter((o) => typeof o === "string" && o) : [];
}

export function getAllowPrivateNetworkFetch() {
    return get()?.allowPrivateNetworkFetch === true;
}

function usable(identity) {
    const name = typeof identity?.name === "string" ? identity.name.trim() : "";
    const email = typeof identity?.email === "string" ? identity.email.trim() : "";
    return name && email ? { name, email } : null;
}

function derivedIdentity() {
    let username = "";
    try {
        username = os.userInfo().username || "";
    } catch { }
    return defaultIdentityFrom(username);
}

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
