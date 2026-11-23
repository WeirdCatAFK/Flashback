/** A request without an Origin header passes, because no browser sent it. The API token gates it. */
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
