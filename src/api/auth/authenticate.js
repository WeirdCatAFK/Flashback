/**
 * Turns a presented token into `req.account`.
 *
 * This replaces the single shared secret that used to guard `/api`. The change is smaller
 * than it looks from the outside: the token a desktop install already holds is adopted as the
 * Author's token when the store is provisioned, so the renderer, the MCP server and the test
 * suite present exactly what they presented before and get exactly what they got before —
 * only now the API knows WHO that is, and the role table has something to compare against.
 *
 * Two things are kept byte-identical on purpose, because clients depend on them:
 *
 *   - **Where the token may appear.** `Authorization: Bearer <token>` OR a `?token=` query
 *     parameter. The query form is not a convenience — a `<img>` or `<audio>` element loading
 *     a PDF page or a media file cannot set a header, and dropping it would break every
 *     renderer that displays an asset.
 *   - **The 401 body.** `{ error: "Unauthorized: ..." }`, which the API client branches on.
 *
 * What is gone is the constant-time comparison, and its absence is not a regression: lookup
 * is now by SHA-256 of the caller's input against an indexed column. Hashing attacker-supplied
 * bytes leaks nothing about the stored value by timing, which is the whole reason tokens are
 * stored hashed.
 */

import { resolveToken, getAuthorAccount } from "../access/primitives/accounts.js";
import { runWithAccount } from "../requestContext.js";

/**
 * Pulls a token out of a request, from either place a client may put it.
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
 * @param {boolean} options.tokenConfigured  whether this install has an `apiToken` at all.
 *   False only in the standalone flows (`dev:api`, `dev:web`) that never run Electron, which
 *   is the one process that mints one.
 * @param {boolean} options.requireAuth  refuse anonymous callers even when no token is
 *   configured. Set by the server entry point; never by the desktop app.
 * @returns {import('express').RequestHandler}
 */
export function authenticate({ tokenConfigured, requireAuth }) {
    return (req, res, next) => {
        const presented = extractToken(req);

        // No credential at all. On a guarded install that is simply a 401. On an unguarded
        // one — a loopback dev server with no Electron to mint a token — it is how every
        // request has always arrived, and the caller is the person sitting at the machine.
        // Treating them as the Author keeps `dev:api` and `dev:web` working exactly as they
        // did, while still giving the role table a subject to check.
        if (!presented) {
            if (tokenConfigured || requireAuth) return res.status(401).json(UNAUTHORIZED);
            return getAuthorAccount().then(
                (author) => {
                    if (!author) return res.status(401).json(UNAUTHORIZED);
                    req.account = author;
                    runWithAccount(author, next);
                },
                next,   // a store failure is a 500 through the error handler, not a 401
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
