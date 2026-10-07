/** Disk usage by durability class. Reporting only — never refuses a write. */

import fs from "fs";
import path from "path";
import {
    getBaseDir, getVaultPath, getWorkspacePath, getDatabasePath, getProgressDatabasePath, get,
} from "./config.js";

/** How long a measurement is reused. A walk is cheap but not free, and the handshake is chatty. */
const CACHE_MS = 60_000;

const SUFFIXES = {
    b: 1,
    k: 1024, kb: 1024, kib: 1024,
    m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2,
    g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
    t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4,
};

let cache = null;

/**
 * Parses a declared size into bytes.
 *
 * Accepts a plain byte count or a binary suffix — `10GB`, `10 GiB`, `512mb`, `1099511627776`.
 * Suffixes are powers of 1024 throughout, because that is what every volume provider quotes
 * and what `df` prints.
 *
 * @param {string|number|undefined|null} value
 * @returns {number|null} bytes, or null when nothing usable was given.
 */
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

/**
 * Total bytes under a path. Missing paths are 0 rather than an error.
 *
 * Follows no symlinks and counts apparent size, not blocks — the figure is meant to be
 * compared against a provider's quota, which is also quoted in apparent bytes.
 *
 * @param {string} target
 * @returns {number}
 */
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

/** A SQLite file plus the WAL and shared-memory files that belong to it. */
function sqliteSize(dbPath) {
    return sizeOf(dbPath) + sizeOf(`${dbPath}-wal`) + sizeOf(`${dbPath}-shm`);
}

/** Drops the cached measurement. Called when the active vault changes. */
export function onVaultOpened() {
    cache = null;
}

/**
 * What the vault occupies now, and what it is allowed if anyone said.
 *
 * @param {{fresh?: boolean}} [options] `fresh` skips the cache.
 * @returns {{limit: number|null, used: number, remaining: number|null, breakdown: object, measuredAt: string}}
 */
export function getStorageReport({ fresh = false } = {}) {
    // Only the WALK is cached. The limit is configuration and may change between two
    // handshakes (serverConfig writes it at startup, a test flips it) — caching it alongside
    // the measurement would report a ceiling that was true a minute ago.
    let measured = (!fresh && cache && Date.now() - cache.at < CACHE_MS) ? cache.measured : null;

    if (!measured) {
        const breakdown = {
            canonical: sizeOf(getWorkspacePath()),
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
