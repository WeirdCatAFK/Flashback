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
    return { status: 500, body: { error: err?.message ?? 'Internal server error' } };
}
