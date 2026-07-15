import path from "path";
import fs from "fs";
import defaultConfig from "../config/defaults/ConfigJSON.js";

let cache = null;

function getConfigPath() {
    if (process.versions.electron) {
        if (!process.env.USER_DATA_PATH) throw new Error("USER_DATA_PATH env var is not set");
        return path.join(process.env.USER_DATA_PATH, "config.json");
    }
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
