import { AsyncLocalStorage } from "node:async_hooks";
import { ROLES } from "../shared/roles.js";

const storage = new AsyncLocalStorage();

export function runWithAccount(account, fn) {
    return storage.run({ account }, fn);
}

export function currentAccount() {
    return storage.getStore()?.account ?? null;
}

export function currentAuthorString(fallback) {
    const account = currentAccount();
    if (account?.name && account?.email) return `${account.name} <${account.email}>`;
    return fallback();
}

export function currentAuthor(fallback) {
    const account = currentAccount();
    if (account?.name && account?.email) return { name: account.name, email: account.email };
    const { name, email } = fallback();
    return { name, email };
}

export const OWNER_SCOPE = "owner";

export function currentScope() {
    const account = currentAccount();
    if (!account) return OWNER_SCOPE;
    return account.role === ROLES.AUTHOR ? OWNER_SCOPE : account.id;
}

export function isOwnerScope(scope) {
    return scope === OWNER_SCOPE;
}
