import process from 'process';
import path from 'path';
import * as config from '../api/access/primitives/config.js';
import { parseSize } from '../api/access/primitives/storage.js';
import { vaultNameError } from '../shared/vaultName.js';

function env(name) {
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const trimmed = String(raw).trim();
    return trimmed === '' ? undefined : trimmed;
}

const VAULT_NAME_PROBLEMS = {
    'required': 'must not be empty',
    'invalid-chars': 'must be a single path component — no "/", "\\", ".." or control characters',
    'too-long': 'is longer than 64 characters',
    'reserved': 'collides with a file the install keeps beside its vaults (config.json, accounts.db, logs)',
    'trailing-dot': 'must not end with a dot or a space',
};

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

    const maxAccounts = env('FLASHBACK_MAX_ACCOUNTS');
    if (maxAccounts !== undefined) {
        const parsed = Number(maxAccounts);
        if (!Number.isInteger(parsed) || parsed < 1) {
            throw new Error(`FLASHBACK_MAX_ACCOUNTS is not a positive integer: "${maxAccounts}".`);
        }
        merged.maxAccounts = parsed;
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
