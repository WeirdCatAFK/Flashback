import fs from "fs";
import path from "path";
import {
    getBaseDir, getVaultPath, getWorkspacePath, getDatabasePath, getProgressDatabasePath, get,
} from "./config.js";

const CACHE_MS = 60_000;

const SUFFIXES = {
    b: 1,
    k: 1024, kb: 1024, kib: 1024,
    m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
    g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
    t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
};

let cache = null;

export function parseSize(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;

    const match = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
    if (!match) return null;

    const amount = Number(match[1]);
    const unit = match[2] === "" ? "b" : match[2];
    const multiplier = SUFFIXES[unit];
    if (!Number.isFinite(amount) || amount <= 0 || multiplier === undefined) return null;

    return Math.floor(amount * multiplier);
}

function sizeOf(target) {
    let total = 0;
    let stat;
    try {
        stat = fs.lstatSync(target);
    } catch {
        return 0;
    }

    if (stat.isSymbolicLink()) return 0;
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;

    let entries;
    try {
        entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        total += sizeOf(path.join(target, entry.name));
    }
    return total;
}

function sqliteSize(dbPath) {
    return sizeOf(dbPath) + sizeOf(`${dbPath}-wal`) + sizeOf(`${dbPath}-shm`);
}

export function onVaultOpened() {
    cache = null;
}

export function getStorageReport({ fresh = false } = {}) {
    let measured = (!fresh && cache && Date.now() - cache.at < CACHE_MS) ? cache.measured : null;

    if (!measured) {
        const breakdown = {
            portable: sizeOf(getWorkspacePath()),
            progress: sqliteSize(getProgressDatabasePath()),
            index: sqliteSize(getDatabasePath()),
            accounts: sqliteSize(path.join(getBaseDir(), "accounts.db")),
            diary: sizeOf(path.join(getVaultPath(), "diary")),
        };
        measured = {
            breakdown,
            used: Object.values(breakdown).reduce((sum, n) => sum + n, 0),
            measuredAt: new Date().toISOString(),
        };
        cache = { at: Date.now(), measured };
    }

    const limit = parseSize(get()?.storageLimit);

    return {
        limit,
        used: measured.used,
        remaining: limit === null ? null : Math.max(0, limit - measured.used),
        breakdown: measured.breakdown,
        measuredAt: measured.measuredAt,
    };
}

export default { parseSize, getStorageReport, onVaultOpened };
