/**
 * Who the current request belongs to, available without threading it through every call.
 *
 * Authorship used to be a property of the INSTALL: `config.getIdentity()` answered "who is
 * using this computer", and a sidecar's `createdBy` and every Seal commit read it. On a
 * server that answer is wrong — the install is a machine in a datacentre, and the person who
 * made the edit is whoever presented the token.
 *
 * Threading an account object from the auth middleware down to `seal.js`'s `author()` would
 * mean a parameter on every orchestrator method between them, most of which have nothing to
 * do with identity. `AsyncLocalStorage` is the right tool for exactly this: the auth
 * middleware enters the context once, and anything running under that request reads it.
 *
 * Deliberately a leaf module — it imports nothing from `access/`, so `config.js`, `seal.js`
 * and `files.js` can all read it without an import cycle or a tier violation.
 *
 * **Background work has no request**, and that is the case the fallback exists for: the
 * canonical UpdateRunner, the Seal debounce firing after its request finished, the recovery
 * CLI. Those legitimately act as the install, so they get the local identity.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { ROLES } from "../shared/roles.js";

const storage = new AsyncLocalStorage();

/**
 * Runs `fn` with `account` as the current request's actor.
 * @param {{id: string, name: string, email: string, role: string}|null} account
 * @param {() => any} fn
 */
export function runWithAccount(account, fn) {
    return storage.run({ account }, fn);
}

/** @returns {object|null} the current request's account, or null outside a request. */
export function currentAccount() {
    return storage.getStore()?.account ?? null;
}

/**
 * The `Name <email>` string to stamp on work done right now.
 *
 * @param {() => string} fallback  what to use with no request in scope — always
 *   `config.getAuthorString`. Passed in rather than imported so this module stays a leaf.
 * @returns {string}
 */
export function currentAuthorString(fallback) {
    const account = currentAccount();
    if (account?.name && account?.email) return `${account.name} <${account.email}>`;
    return fallback();
}

/**
 * The `{name, email}` pair for a git author line.
 *
 * @param {() => {name: string, email: string}} fallback  always `config.getIdentity`.
 * @returns {{name: string, email: string}}
 */
export function currentAuthor(fallback) {
    const account = currentAccount();
    if (account?.name && account?.email) return { name: account.name, email: account.email };
    const { name, email } = fallback();
    return { name, email };
}

/**
 * The account scope every piece of spaced-repetition progress is keyed by.
 *
 * `'owner'` is the vault's Author, and it is deliberately NOT their account id. Account ids
 * live in `accounts.db`, which is install-scoped and does not travel with a copied vault —
 * that is the whole point of keeping the ACL outside the vault. If the Author's uuid were
 * stamped into the vault database, every row of owner progress would orphan the moment the
 * folder was copied to another install. `'owner'` survives the copy and means "whoever owns
 * these files here", which is the sense the sidecar has always carried.
 *
 * It also keeps migration 010 pure SQL: backfilling to a literal needs no account lookup, so
 * nothing about the accounts store has to exist before the vault database is migrated.
 *
 * A uuid can never collide with it, so the sentinel needs no escaping.
 */
export const OWNER_SCOPE = "owner";

/**
 * Whose progress the work running right now belongs to.
 *
 * Resolved ONCE at each orchestrator's entry point and then passed explicitly downward —
 * `query.js` never reads it. Scoping is the single most consequential decision in a
 * multi-user vault, and an ambient read would make it invisible at the call site.
 *
 * With no request in scope — the MCP server's own calls, the canonical UpdateRunner, the
 * recovery CLI, a `dev:api` session with no token — the work is the install's, which is the
 * owner's. Same fallback the authorship helpers above make, for the same reason.
 *
 * @returns {string} an account id, or OWNER_SCOPE.
 */
export function currentScope() {
    const account = currentAccount();
    if (!account) return OWNER_SCOPE;
    return account.role === ROLES.AUTHOR ? OWNER_SCOPE : account.id;
}

/** True when `scope` is the vault owner — the one whose progress is canonical in the sidecar. */
export function isOwnerScope(scope) {
    return scope === OWNER_SCOPE;
}
