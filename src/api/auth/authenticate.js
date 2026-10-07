/** Resolves a Bearer token or ?token= to req.account via SHA-256 lookup. */

import { resolveToken, getAuthorAccount } from "../access/primitives/accounts.js";
import { runWithAccount } from "../requestContext.js";

/**
 * Pulls a token out of a request, from either place a client may put it.
 *
 * @returns {string|null}
 */
export function extractToken(req) {
    const auth = req.headers["authorization"];
    if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
    if (typeof req.query.token === "string") return req.query.token;
    return null;
}

const UNAUTHORIZED = { error: "Unauthorized: missing or invalid API token" };

/**
 * Builds the `/api` authentication middleware.
 *
 * @param {object}  options
 * @param {boolean} options.tokenConfigured  whether this install has an `apiToken` at all. False only in the standalone flows (`dev:api`, `dev:web`) that never run Electron, which is the one process that mints one.
 * @param {boolean} options.requireAuth  refuse anonymous callers even when no token is configured. Set by the server entry point; never by the desktop app.
 * @returns {import('express').RequestHandler}
 */
export function authenticate({ tokenConfigured, requireAuth }) {
    return (req, res, next) => {
        const presented = extractToken(req);

        if (!presented) {
            if (tokenConfigured || requireAuth) return res.status(401).json(UNAUTHORIZED);
            return getAuthorAccount().then(
                (author) => {
                    if (!author) return res.status(401).json(UNAUTHORIZED);
                    req.account = author;
                    runWithAccount(author, next);
                },
                next,
            );
        }

        return resolveToken(presented).then(
            (resolved) => {
                if (!resolved) return res.status(401).json(UNAUTHORIZED);
                req.account = resolved.account;
                req.tokenId = resolved.tokenId;
                runWithAccount(resolved.account, next);
            },
            next,
        );
    };
}
