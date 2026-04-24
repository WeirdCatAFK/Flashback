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

export function getWorkspacePath() {
    const config = get();
    if (config.isCustomPath) {
        if (!path.isAbsolute(config.customPath)) throw new Error("Custom path provided is not absolute");
        return config.customPath;
    }
    const baseDir = process.env.USER_DATA_PATH || path.join(process.cwd(), "data");
    return path.join(baseDir, "workspace");
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
