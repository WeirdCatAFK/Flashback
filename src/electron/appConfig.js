import { app } from "electron";
import path from "path";
import fs from "fs";

const FALLBACK = {
    port: 50500,
    host: 'localhost',
    isLocalhost: true,
    isCustomPath: false,
    customPath: '',
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

/** Electron main and the API process both write config.json, so each update merges into a fresh read. */
export function updateConfig(mutate) {
    const config = readConfig();
    const result = mutate(config) ?? config;
    return writeConfig(result);
}

export function apiBaseUrl(config = readConfig()) {
    return `http://${config.host ?? 'localhost'}:${config.port ?? 50500}`;
}
