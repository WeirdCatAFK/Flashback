/** Per-endpoint role policy. First match wins; unknown mounts fail closed to author. */

import { ROLES, atLeast } from "../../shared/roles.js";

const { READER, COLLABORATOR, ADMIN, AUTHOR } = ROLES;

/**
 * @type {Record<string, Array<[string, string, string]>>}
 */
export const PERMISSIONS = {
    documents: [
        ["GET", "*", READER],
        ["PUT", "/metadata", COLLABORATOR],
        ["*", "/cover", COLLABORATOR],
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
        ["GET", "/*/graph", ADMIN],
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
 * Express middleware factory. Rules are [method, pathPattern, minimumRole], first match wins.
 * req.path is the path within the router (Express strips the mount prefix).
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
