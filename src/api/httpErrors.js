const STORAGE_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

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
    if (isSystemError(err)) {
        return { status: 500, body: { error: 'The server could not read or write a vault file.' } };
    }
    return { status: 500, body: { error: err?.message ?? 'Internal server error' } };
}

/** An OS error message names absolute paths and the account's home folder, so only the server log keeps it. */
function isSystemError(err) {
    return typeof err?.syscall === 'string' || typeof err?.path === 'string' || /^E[A-Z]+$/.test(err?.code ?? '');
}
