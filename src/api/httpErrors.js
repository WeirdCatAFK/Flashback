/**
 * Maps an error that reached the central Express handler to an HTTP status and body.
 *
 * Pure, so `tests/httpErrors.test.js` can pin the mapping without booting a server. Every
 * router's own `catchError` hands unknown errors to `next()`, which is how a filesystem
 * error from a canonical write reaches this from any write route.
 *
 * Three families are recognised:
 *   - body-parser's `entity.too.large` → 413
 *   - a full disk or quota (`ENOSPC`, `EDQUOT`) → 507 `storage_full`; the write that hit the
 *     wall was atomic (see `files.js` `_atomicWrite`), so the file on disk is the previous one
 *   - an error carrying an integer 4xx `status` (`stale`, `path_traversal`, …) → as thrown
 * Everything else is a 500 with the message and nothing more.
 */

/** @typedef {{status: number, body: {error: string, code?: string, etag?: unknown}}} ErrorResponse */

const STORAGE_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

/**
 * @param {any} err
 * @returns {ErrorResponse}
 */
export function statusForError(err) {
    if (err?.type === 'entity.too.large') {
        return { status: 413, body: { error: 'Request body too large' } };
    }
    if (STORAGE_FULL_CODES.has(err?.code)) {
        return { status: 507, body: { error: 'The vault is out of storage.', code: 'storage_full' } };
    }
    if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) {
        const body = { error: err.message };
        if (err.code) body.code = err.code;
        if (err.etag !== undefined) body.etag = err.etag;
        return { status: err.status, body };
    }
    return { status: 500, body: { error: err?.message ?? 'Internal server error' } };
}
