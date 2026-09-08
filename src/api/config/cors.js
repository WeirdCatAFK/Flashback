// CORS policy.
//
// What this defends against: a page on the open web (https://evil.com, an ad frame, a
// malicious doc) making cross-origin requests to the API listening on the user's own
// machine. The previous `Access-Control-Allow-Origin: *` allowed exactly that — and since
// the auth guard also accepts the token as a `?token=` query parameter, any page that ever
// learned the token had a clean path into the vault.
//
// What this does NOT defend against, and is not meant to: non-browser clients. The MCP
// server (src/mcp/client.js), the test suite and any script use Node `fetch`, which sends
// no `Origin` header at all. CORS is a browser mechanism enforced by the browser; it has
// nothing to say about them. Their gate is the API token, checked in api.js.
//
// Three cases, in order:
//   1. No Origin        → pass through, set no ACAO. Not a browser request.
//   2. Origin allowed   → echo it, with `Vary: Origin` since the value is now conditional.
//   3. Origin rejected  → set no ACAO and refuse. The browser would block the response
//                         either way; refusing outright also stops a "simple" cross-origin
//                         POST (which is not preflighted) from executing unread.

import { getAllowedOrigins } from '../access/primitives/config.js';

const ALLOWED_HEADERS = [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
    'X-Flashback-Client',
].join(', ');

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function isAllowed(origin) {
    if (origin === 'null') return true;
    if (LOOPBACK.test(origin)) return true;
    return getAllowedOrigins().includes(origin);
}

export default (req, res, next) => {
    const origin = req.headers.origin;

    if (!origin) return next();

    if (!isAllowed(origin)) {
        return res.status(403).json({ error: `Origin not allowed: ${origin}` });
    }

    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);

    if (req.method === 'OPTIONS') {
        res.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
        res.header('Access-Control-Max-Age', '86400');
        return res.status(204).end();
    }

    return next();
};

export { isAllowed };
