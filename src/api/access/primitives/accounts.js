/**
 * The accounts store — who may reach this API, and as what.
 *
 * Tier 1 (primitives). Imports `config.js` and the adapter factory, nothing else.
 *
 * ## Why it is not in the vault database
 *
 * It lives at `{baseDir}/accounts.db`, a sibling of `config.json`, OUTSIDE every vault. That
 * placement is the feature: a vault folder is meant to be copied, moved, backed up and handed
 * to someone else, and an access list that travelled with it would grant strangers whatever
 * the original readers had. Roles are a fact about this deployment, not about the documents.
 *
 * Two consequences follow, and both matter:
 *
 *   - **The Vault Doctor must never touch this file.** It re-derives the vault database from
 *     the canonical `.flashback` files; there is no canonical form of an account, so a
 *     rebuild that swept this in would delete every token in the deployment.
 *   - **It is the one store in the app that cannot be reconstructed.** Everything in a vault
 *     database can be rebuilt from the files on disk. Nothing here can. It is a backup
 *     obligation, and `DATAMODEL.md` says so.
 *
 * It is also NOT re-opened on a vault switch — accounts belong to the install. `database.js`
 * swaps its handle; this one stays put.
 *
 * ## Tokens
 *
 * Only a SHA-256 hash is stored. The plaintext is returned exactly once, when the token is
 * issued, and after that nobody — including the author — can recover it; they rotate instead.
 * Lookup is therefore by hash of the caller's input, which is why no constant-time comparison
 * appears here: the hash of an attacker-supplied string leaks nothing by timing.
 *
 * ## Why study progress is also here
 *
 * `AccountProgress` is the durable home of every NON-OWNER's spaced-repetition schedule, and
 * it is here for the same reason the access list is: it must not travel with a copied vault.
 *
 * The owner's progress has a canonical home already — the `.flashback` sidecar, versioned by
 * Seal, travelling with the documents it belongs to. Nobody else's can go there. Writing a
 * reader's schedule into a sidecar would seal one person's study record into everyone's git
 * history and hand it to whoever received a copy of the folder. So the split is deliberate
 * and symmetric: owner progress is canonical in the vault, everyone else's is canonical in
 * the install, and both are projected into `CardProgress` in the vault database for querying.
 *
 * Keyed by `card_hash` — the card's `globalHash` — and never by `flashcard_id`, because row
 * ids are local to one vault database and a Doctor rebuild reassigns them. Keyed by
 * `vault_id` (from `vault.json`) because this store is install-scoped and an install can hold
 * several vaults.
 *
 * Only the schedule SNAPSHOT is durable. Review logs are not mirrored here, so a lost vault
 * database still costs everyone their history, their card-health verdicts and their optimizer
 * input — exactly what a Doctor rebuild has always cost the owner. The contract is unchanged,
 * not weakened. `ease_factor` is on this table although `CardProgress` has no such column:
 * SM-2's ease is read back out of the latest review log, and there are no review logs here.
 */

import crypto from "crypto";
import path from "path";
import { createSqliteAdapter } from "./sqliteAdapter.js";
import { getBaseDir, getIdentity } from "./config.js";
import { ROLES, isRole } from "../../../shared/roles.js";

export { ROLES };

/** @returns {string} absolute path to the store. Resolved per call, like every other path. */
export function getAccountsPath() {
    return path.join(getBaseDir(), "accounts.db");
}

// The schema is created here rather than in `defaults/SchemaSQL.js` and is never seen by
// MigrationRunner: that runner is the vault database's, and pointing it at a second store
// would give one version counter two meanings. `AccountsSchemaVersion` is this store's own
// marker, unused so far and present so the first change to this schema has somewhere to
// record itself instead of needing a new table at the worst moment.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS Accounts (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    role        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS AccountTokens (
    id            TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL REFERENCES Accounts(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    label         TEXT,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_tokens_account ON AccountTokens(account_id);
CREATE TABLE IF NOT EXISTS AccountsSchemaVersion (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS AccountProgress (
    vault_id        TEXT NOT NULL,
    account_id      TEXT NOT NULL REFERENCES Accounts(id) ON DELETE CASCADE,
    card_hash       TEXT NOT NULL,
    level           INTEGER,
    sm2_reps        INTEGER NOT NULL DEFAULT 0,
    last_recall     TEXT,
    ease_factor     REAL,
    fsrs_stability  REAL,
    fsrs_difficulty REAL,
    fsrs_due        TEXT,
    fsrs_state      INTEGER NOT NULL DEFAULT 0,
    fsrs_reps       INTEGER NOT NULL DEFAULT 0,
    fsrs_lapses     INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (vault_id, account_id, card_hash)
);
CREATE INDEX IF NOT EXISTS idx_account_progress_vault ON AccountProgress(vault_id, account_id);
`;

const adapter = createSqliteAdapter({
    resolvePath: getAccountsPath,
    // Runs against the fresh handle before anything queries it. Synchronous, and idempotent
    // via IF NOT EXISTS, so opening an existing store costs three no-op DDL statements.
    onOpen: (raw) => raw.exec(SCHEMA),
});

const db = adapter.db;

/** Closes the store. Tests and the CLI use it; the API process never does. */
export const closeAccounts = adapter.closeDatabase;

/** @returns {boolean} whether the store is currently open. */
export const isAccountsOpen = adapter.isOpen;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @returns {string} a fresh opaque token. Same shape and entropy as `config.apiToken`. */
export function generateToken() {
    return crypto.randomBytes(32).toString("hex");
}

/** @returns {string} the stored form of a token. */
export function hashToken(token) {
    return crypto.createHash("sha256").update(String(token)).digest("hex");
}

const now = () => new Date().toISOString();

/** Strips a row down to what a caller may see. Never includes a hash. */
function publicAccount(row) {
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        active: !!row.active,
        createdAt: row.created_at,
    };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** @returns {Promise<object|null>} */
export async function getAccount(id) {
    return publicAccount(await db.prepare("SELECT * FROM Accounts WHERE id = ?").get(id));
}

/** @returns {Promise<object|null>} the Author, or null on a store that has never been seeded. */
export async function getAuthorAccount() {
    return publicAccount(
        await db.prepare("SELECT * FROM Accounts WHERE role = ? ORDER BY created_at LIMIT 1").get(ROLES.AUTHOR),
    );
}

/** @returns {Promise<object[]>} every account, with its token metadata. Never a hash. */
export async function listAccounts() {
    const rows = await db.prepare("SELECT * FROM Accounts ORDER BY created_at").all();
    const tokens = await db.prepare(
        `SELECT id, account_id, label, created_at, last_used_at, revoked_at
           FROM AccountTokens ORDER BY created_at`,
    ).all();

    return rows.map((row) => ({
        ...publicAccount(row),
        tokens: tokens
            .filter((t) => t.account_id === row.id)
            .map((t) => ({
                id: t.id,
                label: t.label,
                createdAt: t.created_at,
                lastUsedAt: t.last_used_at,
                revokedAt: t.revoked_at,
                active: !t.revoked_at,
            })),
    }));
}

/** @returns {Promise<object|null>} one token's metadata (no hash), for the revoke checks. */
export async function getToken(tokenId) {
    const row = await db.prepare(
        `SELECT id, account_id, label, created_at, last_used_at, revoked_at
           FROM AccountTokens WHERE id = ?`,
    ).get(tokenId);
    if (!row) return null;
    return {
        id: row.id,
        accountId: row.account_id,
        label: row.label,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
    };
}

// `last_used_at` is genuinely useful — it is how an admin tells a live token from an
// abandoned one — but writing it per request would mean one write per card in a review
// session. Throttled in memory: at most one write per token per minute. The cache is
// per-process and lost on restart, which costs nothing but an extra write.
const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map();

/**
 * Resolves a presented token to the account behind it.
 *
 * Refuses a revoked token and a deactivated account, which are separate decisions: revoking
 * one token leaves the person's other tokens working, deactivating the account stops all of
 * them at once.
 *
 * @param {string} token plaintext, as presented by the caller.
 * @returns {Promise<{account: object, tokenId: string}|null>}
 */
export async function resolveToken(token) {
    if (!token) return null;
    const row = await db.prepare(
        `SELECT t.id AS token_id, a.*
           FROM AccountTokens t
           JOIN Accounts a ON a.id = t.account_id
          WHERE t.token_hash = ? AND t.revoked_at IS NULL AND a.active = 1`,
    ).get(hashToken(token));
    if (!row) return null;

    const at = Date.now();
    if (at - (lastTouched.get(row.token_id) ?? 0) > TOUCH_INTERVAL_MS) {
        lastTouched.set(row.token_id, at);
        await db.prepare("UPDATE AccountTokens SET last_used_at = ? WHERE id = ?").run(now(), row.token_id);
    }

    return { account: publicAccount(row), tokenId: row.token_id };
}

/** @returns {Promise<boolean>} whether any usable token exists at all — the server-boot check. */
export async function hasUsableToken() {
    const row = await db.prepare(
        `SELECT 1 AS ok FROM AccountTokens t JOIN Accounts a ON a.id = t.account_id
          WHERE t.revoked_at IS NULL AND a.active = 1 LIMIT 1`,
    ).get();
    return !!row;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * @param {{name: string, email: string, role: string}} account
 * @returns {Promise<object>} the created account.
 */
export async function createAccount({ name, email, role }) {
    if (!isRole(role)) throw new Error(`Unknown role: ${role}`);
    const trimmedName = String(name ?? "").trim();
    const trimmedEmail = String(email ?? "").trim();
    if (!trimmedName || !trimmedEmail) throw new Error("An account needs both a name and an email.");

    const id = crypto.randomUUID();
    await db.prepare(
        "INSERT INTO Accounts (id, name, email, role, created_at, active) VALUES (?, ?, ?, ?, ?, 1)",
    ).run(id, trimmedName, trimmedEmail, role, now());
    return await getAccount(id);
}

/**
 * Changes an account's role and/or active flag. Callers enforce WHO may make the change —
 * this only enforces what the data allows.
 *
 * @param {string} id
 * @param {{role?: string, active?: boolean}} changes
 * @returns {Promise<object|null>}
 */
export async function updateAccount(id, { role, active } = {}) {
    if (role !== undefined && !isRole(role)) throw new Error(`Unknown role: ${role}`);

    await db.transaction(async () => {
        if (role !== undefined) await db.prepare("UPDATE Accounts SET role = ? WHERE id = ?").run(role, id);
        if (active !== undefined) {
            await db.prepare("UPDATE Accounts SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
        }
    })();

    return await getAccount(id);
}

/**
 * Issues a token. The plaintext comes back here and NOWHERE else, ever again.
 *
 * @param {string} accountId
 * @param {string} [label] free text, so an admin can tell a laptop from a phone.
 * @returns {Promise<{id: string, token: string, accountId: string, label: string}>}
 */
export async function issueToken(accountId, label = "") {
    const account = await getAccount(accountId);
    if (!account) throw new Error("No such account.");

    const token = generateToken();
    const id = crypto.randomUUID();
    await db.prepare(
        "INSERT INTO AccountTokens (id, account_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, accountId, hashToken(token), String(label ?? ""), now());

    return { id, token, accountId, label: String(label ?? "") };
}

/**
 * Revokes a token. Idempotent — re-revoking keeps the original timestamp, so the record of
 * when access actually ended is not overwritten by a second click.
 *
 * @returns {Promise<boolean>} whether a token was found.
 */
export async function revokeToken(tokenId) {
    const result = await db.prepare(
        "UPDATE AccountTokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(now(), tokenId);
    if (result.changes > 0) return true;
    return !!(await getToken(tokenId));
}

/**
 * Issues a new PURE TOKEN and revokes every previous Author token.
 *
 * The pure token is what proves ownership of the vault: there is one Author, and rotating is
 * the only way to change what proves you are them. Both halves happen in one transaction —
 * a rotation that revoked the old token but failed to write the new one would lock the owner
 * out of their own deployment, and terminal recovery would be the only way back.
 *
 * @param {string} [label]
 * @returns {Promise<{token: string, accountId: string, revoked: number}>}
 */
export async function rotatePureToken(label = "Pure token") {
    return await db.transaction(async () => {
        const author = await getAuthorAccount();
        if (!author) throw new Error("This store has no Author to rotate a token for.");

        const revoked = await db.prepare(
            "UPDATE AccountTokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
        ).run(now(), author.id);

        const token = generateToken();
        await db.prepare(
            "INSERT INTO AccountTokens (id, account_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(crypto.randomUUID(), author.id, hashToken(token), String(label ?? ""), now());

        return { token, accountId: author.id, revoked: revoked.changes };
    })();
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/** The label the desktop install's adopted token carries, so it is recognisable in a list. */
export const LOCAL_TOKEN_LABEL = "This install";

/**
 * Brings the store to a serviceable state, idempotently. Called from `Api.start()`.
 *
 * Two steps, and the second is what makes this milestone invisible on a desktop install:
 *
 *   1. If there is no Author, create one from the local identity — the same name and email
 *      that already stamp `createdBy` and Seal commits. A local vault has exactly one person
 *      and they own it; that is Flashback's normal mode of operation, not a special case.
 *
 *   2. If `config.apiToken` is set, make sure it resolves to that Author. The renderer, the
 *      MCP server and the test suite already hold that token, so adopting it means nothing
 *      they do has to change.
 *
 * Step 2 also RE-ENABLES the token if it was previously revoked, which looks alarming and is
 * not. `config.apiToken` is a plaintext secret sitting in a file next to the vault database:
 * anyone who can read it can already read every document in the vault directly. Refusing to
 * honour it would buy no security and would brick the desktop app after any pure-token
 * rotation, with no way to recover from inside the app. A server has no `apiToken` in its
 * config, so this step does nothing there.
 *
 * @param {string|null} [apiToken]
 * @returns {Promise<object>} the Author account.
 */
export async function ensureLocalAuthor(apiToken = null) {
    let author = await getAuthorAccount();

    if (!author) {
        const { name, email } = getIdentity();
        author = await createAccount({ name, email, role: ROLES.AUTHOR });
    }

    if (apiToken) {
        const hash = hashToken(apiToken);
        const existing = await db.prepare("SELECT id, revoked_at FROM AccountTokens WHERE token_hash = ?").get(hash);
        if (!existing) {
            await db.prepare(
                "INSERT INTO AccountTokens (id, account_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)",
            ).run(crypto.randomUUID(), author.id, hash, LOCAL_TOKEN_LABEL, now());
        } else if (existing.revoked_at) {
            await db.prepare(
                "UPDATE AccountTokens SET revoked_at = NULL, account_id = ? WHERE id = ?",
            ).run(author.id, existing.id);
        }
    }

    return author;
}

// ---------------------------------------------------------------------------
// Durable per-account progress
// ---------------------------------------------------------------------------
//
// The vault database's CardProgress is derived and rebuildable; this is what it is rebuilt
// FROM for everyone who is not the owner. Callers are `srs.js` (on every graded review) and
// `doctor.js` (read-only, when re-projecting after a rebuild).
//
// Deliberately dumb: no scheduling logic, no interpretation of the numbers, no knowledge of
// which algorithm produced them. It stores a snapshot of nine fields and hands them back.

/** The nine schedule fields plus ease, in the order the statements below use them. */
const PROGRESS_FIELDS = [
    "level", "sm2_reps", "last_recall", "ease_factor",
    "fsrs_stability", "fsrs_difficulty", "fsrs_due",
    "fsrs_state", "fsrs_reps", "fsrs_lapses",
];

// The counters are NOT NULL in both this table and the vault's CardProgress; the rest are
// genuinely absent for a card the caller's algorithm has never touched. Writing null into a
// counter would fail the constraint on a snapshot that is otherwise perfectly valid.
const PROGRESS_DEFAULTS = { sm2_reps: 0, fsrs_state: 0, fsrs_reps: 0, fsrs_lapses: 0 };

/**
 * Records one account's schedule for one card. Upsert: a review overwrites the snapshot
 * rather than appending, because this table holds current state, not history.
 *
 * Never call this for the owner — their canonical copy is the sidecar, and a second
 * canonical copy is how the two drift. `srs.js` guards on the scope before it gets here.
 *
 * @param {string} vaultId    from vault.json
 * @param {string} accountId  a real account id, never OWNER_SCOPE
 * @param {string} cardHash   the card's globalHash
 * @param {object} state      any subset of PROGRESS_FIELDS; absent fields reset to defaults
 */
export async function saveAccountProgress(vaultId, accountId, cardHash, state = {}) {
    const values = PROGRESS_FIELDS.map((f) => state[f] ?? PROGRESS_DEFAULTS[f] ?? null);
    await db.prepare(`
        INSERT INTO AccountProgress
            (vault_id, account_id, card_hash, ${PROGRESS_FIELDS.join(", ")}, updated_at)
        VALUES (?, ?, ?, ${PROGRESS_FIELDS.map(() => "?").join(", ")}, ?)
        ON CONFLICT(vault_id, account_id, card_hash) DO UPDATE SET
            ${PROGRESS_FIELDS.map((f) => `${f} = excluded.${f}`).join(", ")},
            updated_at = excluded.updated_at
    `).run(vaultId, accountId, cardHash, ...values, now());
}

/** @returns {Promise<object|null>} one account's snapshot for one card. */
export async function getAccountProgress(vaultId, accountId, cardHash) {
    return await db.prepare(
        "SELECT * FROM AccountProgress WHERE vault_id = ? AND account_id = ? AND card_hash = ?",
    ).get(vaultId, accountId, cardHash);
}

/**
 * Every non-owner snapshot for a vault, for the Doctor to re-project into CardProgress.
 *
 * Rows belonging to accounts that no longer exist are excluded rather than deleted: the
 * cross-store reference carries no foreign key, so nothing cascades, and quietly dropping
 * a row here on a *read* would turn a temporarily-missing account into permanent data loss.
 *
 * @param {string} vaultId
 * @param {string|null} accountId  restrict to one account, or null for all of them
 */
export async function listAccountProgress(vaultId, accountId = null) {
    const filter = accountId ? " AND p.account_id = ?" : "";
    const params = accountId ? [vaultId, accountId] : [vaultId];
    return await db.prepare(`
        SELECT p.* FROM AccountProgress p
        JOIN Accounts a ON a.id = p.account_id
        WHERE p.vault_id = ?${filter}
    `).all(...params);
}

/** Forgets one card's snapshot for one account. Used when a review is undone to nothing. */
export async function deleteAccountProgress(vaultId, accountId, cardHash) {
    await db.prepare(
        "DELETE FROM AccountProgress WHERE vault_id = ? AND account_id = ? AND card_hash = ?",
    ).run(vaultId, accountId, cardHash);
}

export default {
    ROLES,
    getAccountsPath,
    closeAccounts,
    isAccountsOpen,
    generateToken,
    hashToken,
    getAccount,
    getAuthorAccount,
    listAccounts,
    getToken,
    resolveToken,
    hasUsableToken,
    createAccount,
    updateAccount,
    issueToken,
    revokeToken,
    rotatePureToken,
    ensureLocalAuthor,
    saveAccountProgress,
    getAccountProgress,
    listAccountProgress,
    deleteAccountProgress,
    LOCAL_TOKEN_LABEL,
};
