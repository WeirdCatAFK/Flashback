// config.json access for the Electron main process.
//
// Extracted from main.js so vaults.js can share it rather than growing a second copy of
// the read/write pair. Main is one of two writers of this file (the API process is the
// other), which is why updateConfig() always merges into a fresh read instead of writing
// back an object it has been holding.

import { app } from "electron";
import path from "path";
import fs from "fs";

const FALLBACK = {
    port: 50500,
    host: 'localhost',
    isLocalhost: true,
    isCustomPath: false,
    customPath: '',
    logFormat: 'dev',
    vaultName: 'default',
};

export function getConfigPath() {
    return path.join(app.getPath('userData'), 'config.json');
}

export function configExists() {
    return fs.existsSync(getConfigPath());
}

export function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8'));
    } catch {
        return { ...FALLBACK };
    }
}

export function writeConfig(config) {
    fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
    return config;
}

/**
 * Read-modify-write against what is currently on disk.
 *
 * The re-read is the point: the API process writes the active-vault pointer to this same
 * file, so a mutation applied to a stale in-memory copy would silently revert it.
 *
 * @param {(config: object) => object|void} mutate - mutates in place, or returns a replacement.
 * @returns {object} the config as written.
 */
export function updateConfig(mutate) {
    const config = readConfig();
    const result = mutate(config) ?? config;
    return writeConfig(result);
}

/** Base URL of the local API, from the current config. */
export function apiBaseUrl(config = readConfig()) {
    return `http://${config.host ?? 'localhost'}:${config.port ?? 50500}`;
}
