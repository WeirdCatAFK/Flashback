/**
 * The central error mapping — pure, so no vault, no SQLite, no server.
 *
 * What is pinned: a full disk answers a status a client can act on (507 `storage_full`)
 * rather than a bare 500 with a Node errno in the message, and the two existing families
 * (body-parser's 413, the thrown 4xx objects with `code`/`etag`) still come out unchanged.
 *
 * Run: node --test tests/httpErrors.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statusForError } from '../src/api/httpErrors.js';

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

    it('falls back to 500 with the message, and survives a non-Error', () => {
        assert.deepEqual(statusForError(new Error('boom')), { status: 500, body: { error: 'boom' } });
        assert.equal(statusForError(undefined).status, 500);
        assert.equal(statusForError('a string').body.error, 'Internal server error');
    });
});
