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
    // admin may not revoke their own token — are enforced in routes/accounts.js, where the
    // actor and the target can be compared.
    accounts: [
        ["POST", "/pure-token", AUTHOR],
        ["*", "*", ADMIN],
    ],
};

// Matches a rule's path pattern against a request path.
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
 * @returns {string} a role. Never null: an unknown mount resolves to AUTHOR.
 */
export function requiredRole(mount, method, reqPath) {
    const rules = PERMISSIONS[mount];
    if (!rules) return AUTHOR;

    const verb = String(method || "").toUpperCase();
    const p = reqPath || "/";
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
