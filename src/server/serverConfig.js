/**
 * Server configuration from the environment.
 *
 * A container is configured by env vars, but `config.json` is what the API actually reads —
 * and not only at boot. `cors.js` calls `config.getAllowedOrigins()` per request, path
 * resolution calls `getVaultPath()` per call, and both read through the same cached `get()`.
 * So an override held only in memory in this module would be invisible to them. The env is
 * therefore merged INTO the file, once, before `openVault()` runs.
 *
 * That merge is deliberately one-directional and non-destructive: an env var that is not set
 * leaves whatever is on disk alone, so a hand-edited `config.json` on a mounted volume keeps
 * working, and a restart with no env at all is a no-op rather than a reset to defaults.
 *
 * The one thing that is NOT written here is the author token. `Api.start()` hands it to
 * `accounts.ensureLocalAuthor()`, which stores only its SHA-256 — so after the first boot the
 * token works from the accounts store and persisting the plaintext would buy nothing but a
 * secret sitting in a file on a mounted volume. It is passed to the `Api` constructor and
 * never written down.
 *
 *   FLASHBACK_PORT              port to listen on                (default: 50500)
 *   FLASHBACK_HOST              interface to bind                (default: 0.0.0.0)
 *   FLASHBACK_VAULT_NAME        which vault directory to serve   (default: existing/"dreams")
 *   FLASHBACK_ALLOWED_ORIGINS   comma-separated browser origins  (default: unchanged)
 *   FLASHBACK_LOG_FORMAT        morgan format                    (default: unchanged)
 *   FLASHBACK_AUTHOR_TOKEN      adopt this token as the Author's (default: mint one)
 *   FLASHBACK_USER_NAME         identity new work is stamped with (default: OS account)
 *   FLASHBACK_USER_EMAIL        — must be set together with the name
 *   USER_DATA_PATH              the data volume                  (read by config.js itself)
 *
 * One server variable is deliberately NOT handled here: FLASHBACK_UPDATE_CHECK. It gates an
 * outbound request, not a stored setting, so `updateCheck.js` reads it directly rather than
 * persisting it to config.json where an operator would then have two places to turn it off.
 */

import process from 'process';
import path from 'path';
import * as config from '../api/access/primitives/config.js';
import { parseSize } from '../api/access/primitives/storage.js';
import { vaultNameError } from '../shared/vaultName.js';

/** Reads an env var, treating whitespace-only as unset. */
function env(name) {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const trimmed = String(raw).trim();
    return trimmed === '' ? undefined : trimmed;
}

/** What each `vaultNameError()` code means for an operator setting an env var. */
const VAULT_NAME_PROBLEMS = {
    'required': 'must not be empty',
    'invalid-chars': 'must be a single path component — no "/", "\\", ".." or control characters',
    'too-long': 'is longer than 64 characters',
    'reserved': 'collides with a file the install keeps beside its vaults (config.json, accounts.db, logs)',
    'trailing-dot': 'must not end with a dot or a space',
};

/**
 * Merges the environment into `config.json` and returns the config the server should run with.
 *
 * @returns {{config: object, authorToken: string|undefined}}
 */
export function applyServerConfig() {
    const current = config.get();
    if (!current) throw new Error('Could not read or create config.json.');

    const merged = { ...current };

    const port = env('FLASHBACK_PORT');
    if (port !== undefined) {
        const parsed = Number(port);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
            throw new Error(`FLASHBACK_PORT is not a valid port: ${port}`);
        }
        merged.port = parsed;
    }

    merged.host = env('FLASHBACK_HOST') ?? '0.0.0.0';
    merged.isLocalhost = merged.host === 'localhost' || merged.host === '127.0.0.1';

    const vaultName = env('FLASHBACK_VAULT_NAME');
    if (vaultName !== undefined) {
        const problem = vaultNameError(vaultName);
        if (problem) {
            throw new Error(
                `FLASHBACK_VAULT_NAME ${VAULT_NAME_PROBLEMS[problem] ?? `is not usable (${problem})`}: ` +
                `"${vaultName}"`
            );
        }
        merged.vaultName = vaultName;
    }

    // The canonical layer and the derived index can each sit on their own mount. Absolute
    // only, and checked here rather than at first use: a relative path would resolve against
    // the container's working directory, and the failure would surface as an empty vault
    // rather than as a configuration error.
    for (const [name, field] of [
        ['FLASHBACK_WORKSPACE_PATH', 'workspacePath'],
        ['FLASHBACK_INDEX_PATH', 'indexPath'],
    ]) {
        const value = env(name);
        if (value === undefined) continue;
        if (!path.isAbsolute(value)) {
            throw new Error(`${name} must be an absolute path, got "${value}"`);
        }
        merged[field] = value;
    }

    // How much room this deployment actually has. Declared rather than measured because a
    // container's statvfs reports the host's filesystem and a named volume has no quota of
    // its own — see access/primitives/storage.js. Reporting only; nothing refuses a write.
    const storageLimit = env('FLASHBACK_STORAGE_LIMIT');
    if (storageLimit !== undefined) {
        if (parseSize(storageLimit) === null) {
            throw new Error(
                `FLASHBACK_STORAGE_LIMIT is not a size: "${storageLimit}". ` +
                'Use a byte count or a suffix, e.g. 10GB, 512MB, 2TiB.'
            );
        }
        merged.storageLimit = storageLimit;
    }

    const origins = env('FLASHBACK_ALLOWED_ORIGINS');
    if (origins !== undefined) {
        merged.allowedOrigins = origins.split(',').map((o) => o.trim()).filter(Boolean);
    }

    merged.logFormat = env('FLASHBACK_LOG_FORMAT') ?? current.logFormat ?? 'combined';

    const userName = env('FLASHBACK_USER_NAME');
    const userEmail = env('FLASHBACK_USER_EMAIL');
    if (userName && userEmail) {
        merged.user = { ...(current.user ?? {}), name: userName, email: userEmail };
    } else if (userName || userEmail) {
        throw new Error('FLASHBACK_USER_NAME and FLASHBACK_USER_EMAIL must be set together.');
    }

    merged.requireAuth = true;

    merged.singleVault = true;

    if (!config.set(merged)) throw new Error('Could not write config.json.');
    config.reload();

    return { config: config.get(), authorToken: env('FLASHBACK_AUTHOR_TOKEN') };
}

export default applyServerConfig;
