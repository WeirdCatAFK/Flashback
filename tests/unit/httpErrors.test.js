import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statusForError } from '../../src/api/httpErrors.js';

describe('statusForError', () => {
    it('answers a full disk or quota with 507 storage_full, whichever errno the filesystem uses', () => {
        for (const code of ['ENOSPC', 'EDQUOT']) {
            const err = Object.assign(new Error(`${code}: no space left on device, write`), { code, errno: -28 });
            const { status, body } = statusForError(err);
            assert.equal(status, 507, code);
            assert.equal(body.code, 'storage_full');
            assert.ok(!/ENOSPC|EDQUOT/.test(body.error), 'the errno stays out of the message a person reads');
        }
    });

    it('keeps body-parser\'s 413', () => {
        const { status, body } = statusForError(Object.assign(new Error('too large'), { type: 'entity.too.large' }));
        assert.equal(status, 413);
        assert.equal(body.error, 'Request body too large');
    });

    it('passes a thrown 4xx through with its code and etag', () => {
        const err = Object.assign(new Error('This document changed since you last read it.'), {
            status: 409, code: 'stale', etag: 'abc.def',
        });
        const { status, body } = statusForError(err);
        assert.equal(status, 409);
        assert.deepEqual(body, { error: err.message, code: 'stale', etag: 'abc.def' });
    });

    it('does not honour a status outside 4xx — a thrown 5xx is still a 500', () => {
        const { status } = statusForError(Object.assign(new Error('x'), { status: 503 }));
        assert.equal(status, 500);
    });

    it('hides an OS error message, which names absolute paths, behind a generic 500', () => {
        const err = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\Users\\someone\\vault\\a.md'"), {
            code: 'ENOENT', syscall: 'open', path: 'C:\\Users\\someone\\vault\\a.md',
        });
        const { status, body } = statusForError(err);
        assert.equal(status, 500);
        assert.ok(!body.error.includes('someone'), 'no path reaches the client');
    });

    it('falls back to 500 with the message, and survives a non-Error', () => {
        assert.deepEqual(statusForError(new Error('boom')), { status: 500, body: { error: 'boom' } });
        assert.equal(statusForError(undefined).status, 500);
        assert.equal(statusForError('a string').body.error, 'Internal server error');
    });
});
