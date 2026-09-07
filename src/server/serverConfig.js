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
import * as config from '../api/access/primitives/config.js';
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
 * Merges the environment into `config.json` and returns the config the server should run
 * with. Must be called BEFORE `openVault()` — it can change which vault that opens.
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

    // A server binds every interface by default — the opposite of the desktop app, where
    // localhost-only is the safe answer. `isLocalhost` is kept consistent with `host` rather
    // than left to contradict it, because api.js warns and overrides when they disagree.
    merged.host = env('FLASHBACK_HOST') ?? '0.0.0.0';
    merged.isLocalhost = merged.host === 'localhost' || merged.host === '127.0.0.1';

    // The vault name is a path component, and `getVaultPath()` joins it onto the volume root
    // with no validation of its own — so "shared/v2" quietly nests a vault a level down and
    // "../elsewhere" resolves outside the volume entirely. Neither fails at boot; both fail
    // later as an empty vault where the real one was expected, which is the worst shape a
    // storage bug can take. The desktop app has always validated this (Setup, the vault
    // manager, the rename IPC all call vaultNameError); the server path never did.
    //
    // Validated ONLY when the variable is actually set. A name already sitting in
    // config.json is left alone even if it would fail these rules today — this merge is
    // non-destructive by contract, and refusing to boot over a vault that has been serving
    // fine would turn a lint into an outage. The check bites when someone hands us a new
    // name, which is when it can still do some good.
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

    // Split on commas, not on whitespace: an origin cannot contain a comma, and this way a
    // value with a stray space around an entry still does what its author meant.
    const origins = env('FLASHBACK_ALLOWED_ORIGINS');
    if (origins !== undefined) {
        merged.allowedOrigins = origins.split(',').map((o) => o.trim()).filter(Boolean);
    }

    merged.logFormat = env('FLASHBACK_LOG_FORMAT') ?? current.logFormat ?? 'combined';

    // Who this install stamps its own work as. Without it the identity is derived from the
    // OS account, which in a container is the `node` user — so every document created here
    // and every Seal commit is authored by "node <node@flashback.local>". That is not wrong
    // so much as useless, and it is baked into a git history that outlives the container.
    //
    // Both halves or neither: `config.getIdentity()` only accepts a pair where both are
    // non-empty, and writing half of one would silently fall back to the derived default
    // while looking configured.
    //
    // Caveat worth knowing: `ensureLocalAuthor()` builds the Author account from this the
    // FIRST time it runs. Setting it later changes what background work is stamped with,
    // but does not rename an Author who already exists — use PATCH /api/accounts/:id.
    const userName = env('FLASHBACK_USER_NAME');
    const userEmail = env('FLASHBACK_USER_EMAIL');
    if (userName && userEmail) {
        merged.user = { ...(current.user ?? {}), name: userName, email: userEmail };
    } else if (userName || userEmail) {
        throw new Error('FLASHBACK_USER_NAME and FLASHBACK_USER_EMAIL must be set together.');
    }

    // Refuse anonymous callers, and refuse to boot with no way to authenticate. This is the
    // whole difference between "a dev server on loopback" and "a service on a network", and
    // it is set here rather than in the shared constructor so the desktop app can never
    // acquire it by accident.
    merged.requireAuth = true;

    // One vault per server: /api/vault/switch and /release are unmounted (see api.js).
    merged.singleVault = true;

    if (!config.set(merged)) throw new Error('Could not write config.json.');
    config.reload();

    return { config: config.get(), authorToken: env('FLASHBACK_AUTHOR_TOKEN') };
}

export default applyServerConfig;
