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
    // Reading a document is the whole point of a reader's access. Everything that changes
    // the SHAPE of the vault — creating, moving, renaming, deleting, importing — is admin.
    // The one exception is a metadata write, which is how an annotation is saved: highlights,
    // tags and cards all live in the sidecar, so a collaborator who could not PUT metadata
    // could not annotate anything.
    documents: [
        ["GET", "*", READER],
        ["PUT", "/metadata", COLLABORATOR],
        ["*", "*", ADMIN],
    ],

    // Highlights ARE the annotation surface. A collaborator owns this router outright.
    highlights: [
        ["GET", "*", READER],
        ["*", "*", COLLABORATOR],
    ],

    // Serving an asset is a read. Attaching one to a card a collaborator is allowed to make
    // is not an import — `reconcile` and deletion are vault surgery, so they are admin.
    media: [
        ["GET", "*", READER],
        ["POST", "/vanilla", COLLABORATOR],
        ["POST", "/custom", COLLABORATOR],
        ["*", "*", ADMIN],
    ],

    // Read-only by construction: extraction, search, and who this install stamps work as.
    reader: [["*", "*", READER]],
    search: [["*", "*", READER]],
    identity: [["*", "*", READER]],

    // A reader's review progress is the one thing a reader is FOR — and since M2 every
    // endpoint here operates on the CALLER's own schedule, including `optimize`. Fitted FSRS
    // weights are a model of one individual's forgetting curve, stored per account, so
    // refitting them changes nothing anyone else can see. It was admin-only while the weights
    // were one shared row per vault; it is not an administrative act any more.
    srs: [["*", "*", READER]],

    // Reading a card and dismissing a health flag on it are part of studying. Authoring one
    // is not. The two stars stand for the card hash and the flag kind.
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

    // An import creates documents, which is exactly the line a collaborator does not cross.
    subscriptions: [
        ["GET", "*", READER],
        ["*", "*", ADMIN],
    ],

    // Until M2 gives every account its own diary, this serves one shared record. A reader
    // reaching it sees their own study history on a desktop install, which is the only
    // shape that exists today; scoping it per account is M2's job, not the guard's.
    diary: [["*", "*", READER]],

    // Reading the vault's history is an audit power. Rewinding it is destructive and
    // irreversible from inside the app — only the owner.
    seal: [
        ["GET", "*", ADMIN],
        ["POST", "/rollback", AUTHOR],
        ["*", "*", AUTHOR],
    ],

    // Checking the index is diagnosis. Syncing and rebuilding rewrite the derived layer, and
    // a rebuild discards review history — author only.
    doctor: [
        ["GET", "/check", ADMIN],
        ["*", "*", AUTHOR],
    ],

    // The handshake (`GET /`) is deliberately open to any authenticated caller: a client has
    // to be able to ask what it just connected to. Everything else moves or releases the
    // active vault, which one person owns.
    vault: [
        ["GET", "/", READER],
        ["*", "*", AUTHOR],
    ],

    // Which other servers this install knows about is nobody's business but the owner's.
    remotes: [["*", "*", AUTHOR]],

    // Managing access is an admin power; minting the token that PROVES ownership is not.
    // The two rules an ordering cannot express — an admin may grant only Reader, and an
    // admin may not revoke their own token or act on a peer — are enforced in
    // routes/accounts.js, where the actor and the target can be compared.
    //
    // This mount is the ONE that enumerates its admin routes and ends in AUTHOR, rather
    // than naming its author route and ending in ADMIN. The shape is deliberate.
    //
    // First match wins, so a rule that requires MORE than the catch-all below it is only
    // as strong as the matcher's ability to recognise the path — and any request that
    // fails to match it lands on something weaker. That is not hypothetical: with
    // `["POST", "/pure-token", AUTHOR]` sitting above an ADMIN catch-all, Express's
    // case-insensitive routing sent `POST /api/accounts/Pure-Token` to the pure-token
    // handler while the guard read it as an unremarkable admin call, so any admin could
    // mint the Author's token — and rotation revokes every existing Author token, locking
    // the owner out of their own vault.
    //
    // normalizePath now closes that particular door. Inverting the mount closes the
    // corridor: `/pure-token` needs no rule at all, because falling through to AUTHOR is
    // the correct answer for it and for every misspelling of it. A new route added to
    // routes/accounts.js is author-only until someone deliberately lists it here, which is
    // the same fail-closed direction as an unknown mount.
    accounts: [
        ["GET", "/", ADMIN],                 // the people table
        ["POST", "/", ADMIN],                // create an account
        ["PATCH", "/*", ADMIN],              // change a role / deactivate
        ["GET", "/*/progress", ADMIN],       // read one person's schedule
        ["POST", "/*/tokens", ADMIN],        // issue a token
        ["DELETE", "/tokens/*", ADMIN],      // revoke one
        ["*", "*", AUTHOR],                  // POST /pure-token, and anything new
    ],
};

/**
 * The form of a request path that the rules below are written against.
 *
 * Express routes **case-insensitively and non-strictly** by default, so `/Pure-Token`,
 * `/PURE-TOKEN` and `/pure-token/` all reach the `/pure-token` handler. The guard compares
 * strings, so without this it saw three paths the table has no rule for and fell through to
 * the mount's catch-all — which for `accounts` is ADMIN, one rung below the AUTHOR the
 * pure-token rule names. Capitalising one letter was a full vault takeover.
 *
 * Setting `case sensitive routing` on the app does NOT close this: that option configures
 * only the app's own base router (express/lib/application.js), while every router in
 * `routes/` is constructed with its own empty options object and defaults back to
 * insensitive. The guard has to compare what the ROUTER will match, not what the caller
 * typed, and this is the only place that can be true of.
 *
 * Used for COMPARISON only — never to rewrite `req.url` or `req.path`. Several routes carry
 * case-significant data in the path (`/by-hash/:hash`, `/summary/:date`, `/entry/:date`),
 * and lowercasing what the handler receives would corrupt it.
 *
 * @param {string} p
 * @returns {string}
 */
export function normalizePath(p) {
    const s = String(p || "/").toLowerCase();
    return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

// Matches a rule's path pattern against a request path. The path is expected to have been
// through normalizePath already; every pattern below is written in that same form.
//
//   "*"            matches anything
//   "/foo/*"       matches that prefix and everything under it
//   "/a/*/b"       a star in the middle matches exactly ONE path segment, which is what
//                  lets a rule name a shape ("dismiss a flag on any card") rather than a
//                  particular card
//   anything else  is literal
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
 * @param {string} reqPath  the path WITHIN the router (Express strips the mount prefix).
 *   Normalized here, so a caller passes it through verbatim — see normalizePath.
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
 * Express middleware factory. One per mounted router.
 *
 * @param {string} mount
 * @returns {import('express').RequestHandler}
 */
export function guard(mount) {
    return (req, res, next) => {
        const needed = requiredRole(mount, req.method, req.path);
        const role = req.account?.role;

        if (atLeast(role, needed)) return next();

        // Naming the required role is deliberate. The caller is already authenticated, so
        // this tells them nothing they could not learn by trying every endpoint — and
        // without it a client cannot tell "you may not" from "this is broken".
        return res.status(403).json({
            error: `Forbidden: this requires the ${needed} role.`,
            required: needed,
            role: role ?? null,
        });
    };
}
