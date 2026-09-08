/**
 * What each role may reach. One table, one place to be wrong.
 *
 * The alternative — a role check inside each handler — was rejected because the failure mode
 * is silence: a handler that forgets its check is indistinguishable from one that is meant to
 * be open, and nothing about the file says which. Here, every endpoint's answer is on one
 * screen, a reviewer can read the whole policy in a minute, and `tests/accounts.test.js`
 * asserts that every router mounted in `api.js` appears below.
 *
 * ## How it is applied
 *
 * `api.js` mounts the guard alongside each router:
 *
 *     app.use('/api/documents', guard('documents'), documentsRouter);
 *
 * Express strips the mount prefix inside a `use` middleware, so `req.path` here is the path
 * WITHIN the router — `/list`, `/metadata` — which is exactly the granularity the rules need
 * without touching a single handler.
 *
 * ## How a rule is read
 *
 *     [method, pathPattern, minimumRole]
 *
 * `method` is an HTTP verb or `*`. `pathPattern` is `*` for everything, a literal path, or a
 * prefix ending in `/*`. **First match wins**, so rules go from most specific to least, and
 * every mount ends with a catch-all.
 *
 * ## It fails closed
 *
 * A mount with no entry resolves to `author` — the most restrictive role — rather than to
 * "allowed". A new router that nobody added here stops working immediately and loudly, which
 * is the correct direction for the mistake to fall: the alternative is a route that quietly
 * serves everyone.
 */

import { ROLES, atLeast } from "../../shared/roles.js";

const { READER, COLLABORATOR, ADMIN, AUTHOR } = ROLES;

/**
 * @type {Record<string, Array<[string, string, string]>>}
 */
export const PERMISSIONS = {
    documents: [
        ["GET", "*", READER],
        ["PUT", "/metadata", COLLABORATOR],
        ["*", "*", ADMIN],
    ],

    highlights: [
        ["GET", "*", READER],
        ["*", "*", COLLABORATOR],
    ],

    media: [
        ["GET", "*", READER],
        ["POST", "/vanilla", COLLABORATOR],
        ["POST", "/custom", COLLABORATOR],
        ["*", "*", ADMIN],
    ],

    reader: [["*", "*", READER]],
    search: [["*", "*", READER]],
    identity: [["*", "*", READER]],

    srs: [["*", "*", READER]],

    progress: [["*", "*", READER]],

    flashcards: [
        ["GET", "*", READER],
        ["POST", "/*/flags/*/dismiss", READER],
        ["*", "*", ADMIN],
    ],

    decks: [
        ["GET", "*", READER],
        ["*", "*", ADMIN],
    ],
    categories: [
        ["GET", "*", READER],
        ["*", "*", ADMIN],
    ],

    subscriptions: [
        ["GET", "*", READER],
        ["*", "*", ADMIN],
    ],

    diary: [["*", "*", READER]],

    seal: [
        ["GET", "*", ADMIN],
        ["POST", "/rollback", AUTHOR],
        ["*", "*", AUTHOR],
    ],

    doctor: [
        ["GET", "/check", ADMIN],
        ["*", "*", AUTHOR],
    ],

    vault: [
        ["GET", "/", READER],
        ["*", "*", AUTHOR],
    ],

    remotes: [["*", "*", AUTHOR]],

    accounts: [
        ["GET", "/", ADMIN],
        ["POST", "/", ADMIN],
        ["PATCH", "/*", ADMIN],
        ["GET", "/*/progress", ADMIN],
        ["POST", "/*/tokens", ADMIN],
        ["DELETE", "/tokens/*", ADMIN],
        ["*", "*", AUTHOR],
    ],
};

/**
 * The form of a request path that the rules below are written against.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
    const s = String(p || "/").toLowerCase();
    return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

function pathMatches(pattern, reqPath) {
    if (pattern === "*") return true;
    if (pattern === reqPath) return true;

    if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -2);
        if (reqPath === prefix || reqPath.startsWith(`${prefix}/`)) return true;
    }

    if (!pattern.includes("*")) return false;

    const patternParts = pattern.split("/");
    const pathParts = reqPath.split("/");
    if (patternParts.length !== pathParts.length) return false;
    return patternParts.every((part, i) => part === "*" || part === pathParts[i]);
}

/**
 * The minimum role required to make this request.
 *
 * @param {string} mount  the mount name — the key in PERMISSIONS, not the URL.
 * @param {string} method
 * @param {string} reqPath  the path WITHIN the router (Express strips the mount prefix). Normalized here, so a caller passes it through verbatim — see normalizePath.
 * @returns {string} a role. Never null: an unknown mount resolves to AUTHOR.
 */
export function requiredRole(mount, method, reqPath) {
    const rules = PERMISSIONS[mount];
    if (!rules) return AUTHOR;

    const verb = String(method || "").toUpperCase();
    const p = normalizePath(reqPath);
    for (const [ruleMethod, rulePath, role] of rules) {
        if (ruleMethod !== "*" && ruleMethod !== verb) continue;
        if (!pathMatches(rulePath, p)) continue;
        return role;
    }
    return AUTHOR;
}

/**
 * Express middleware factory.
 *
 * @param {string} mount
 * @returns {import('express').RequestHandler}
 */
export function guard(mount) {
    return (req, res, next) => {
        const needed = requiredRole(mount, req.method, req.path);
        const role = req.account?.role;

        if (atLeast(role, needed)) return next();

        return res.status(403).json({
            error: `Forbidden: this requires the ${needed} role.`,
            required: needed,
            role: role ?? null,
        });
    };
}
