/** AsyncLocalStorage carrying the current request's account. Leaf module — no access/ imports. */

import { AsyncLocalStorage } from "node:async_hooks";
import { ROLES } from "../shared/roles.js";

const storage = new AsyncLocalStorage();

/**
 * Runs `fn` with `account` as the current request's actor.
 *
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
 * @param {() => string} fallback  what to use with no request in scope — always `config.getAuthorString`. Passed in rather than imported so this module stays a leaf.
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

/** The account scope every piece of spaced-repetition progress is keyed by. */
export const OWNER_SCOPE = "owner";

/**
 * Whose progress the work running right now belongs to.
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
