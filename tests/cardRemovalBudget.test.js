// Card-removal budget — the volume limit on flashcard deletions through a metadata write.
//
// Pure: no vault, no SQLite, no Electron. Runs standalone with
// `node --test tests/cardRemovalBudget.test.js` even on a tree that has never been built,
// like tests/sequencing.test.js and tests/safeFetch.test.js.
//
// Every case injects `now` rather than sleeping. A rolling window tested with real time is
// a test that is either slow or flaky, and usually both.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { check, consume, reset } from '../src/api/access/resources/cardRemovalBudget.js';

const LIMITS = { perHour: 20, perRequest: 10 };
const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

describe('card removal budget', () => {
    beforeEach(() => reset());

    it('allows a removal that fits both limits', () => {
        const v = check('acct-a', 5, LIMITS, T0);
        assert.equal(v.allowed, true);
        assert.equal(v.used, 0);
        assert.equal(v.remaining, 20);
        assert.equal(v.reason, null);
    });

    it('refuses a single request larger than the per-request cap, on an untouched budget', () => {
        // The case that matters: "delete this document's 200 cards in one call" must fail
        // even with the whole hourly allowance available, or the cap buys nothing.
        const v = check('acct-a', 200, LIMITS, T0);
        assert.equal(v.allowed, false);
        assert.equal(v.reason, 'per_request');
        assert.equal(v.remaining, 20, 'nothing consumed yet');
    });

    it('names per_request rather than per_hour when both are exceeded', () => {
        // "Wait an hour" is a misleading answer to a request that is too big at any hour.
        consume('acct-a', 18, T0);
        const v = check('acct-a', 50, LIMITS, T0);
        assert.equal(v.allowed, false);
        assert.equal(v.reason, 'per_request');
        assert.equal(v.remaining, 2, 'the hourly budget is nearly gone too, but per_request wins');
    });

    it('check() does not consume', () => {
        for (let i = 0; i < 5; i++) check('acct-a', 10, LIMITS, T0);
        assert.equal(check('acct-a', 10, LIMITS, T0).remaining, 20);
    });

    it('accumulates across requests and refuses once the hourly budget is spent', () => {
        consume('acct-a', 10, T0);
        assert.equal(check('acct-a', 10, LIMITS, T0).remaining, 10);

        consume('acct-a', 10, T0 + 1000);
        const v = check('acct-a', 1, LIMITS, T0 + 2000);
        assert.equal(v.allowed, false);
        assert.equal(v.reason, 'per_hour');
        assert.equal(v.remaining, 0);
        assert.equal(v.used, 20);
    });

    it('reports the allowance that is actually left, not just allowed/denied', () => {
        consume('acct-a', 14, T0);
        const v = check('acct-a', 10, LIMITS, T0);
        assert.equal(v.allowed, false);
        assert.equal(v.reason, 'per_hour');
        assert.equal(v.remaining, 6, 'six left, so a batch of six would go through');
        assert.equal(check('acct-a', 6, LIMITS, T0).allowed, true);
    });

    it('refills as removals age out of the rolling window', () => {
        consume('acct-a', 20, T0);
        assert.equal(check('acct-a', 1, LIMITS, T0 + HOUR - 1000).allowed, false);

        // One millisecond past the window and the whole batch has aged out.
        const after = check('acct-a', 10, LIMITS, T0 + HOUR + 1);
        assert.equal(after.allowed, true);
        assert.equal(after.used, 0);
        assert.equal(after.remaining, 20);
    });

    it('rolls rather than resetting: only the aged-out part comes back', () => {
        consume('acct-a', 10, T0);
        consume('acct-a', 10, T0 + (HOUR / 2));

        // Just past the first batch's expiry: the second is still counted.
        const v = check('acct-a', 1, LIMITS, T0 + HOUR + 1);
        assert.equal(v.used, 10);
        assert.equal(v.remaining, 10);
        assert.equal(v.allowed, true);
    });

    it('reports when the budget next refills', () => {
        consume('acct-a', 20, T0);
        const v = check('acct-a', 5, LIMITS, T0 + 1000);
        assert.equal(v.resetAt, T0 + HOUR, 'oldest removal + one hour');
        assert.equal(v.retryAfter, Math.ceil((HOUR - 1000) / 1000));
    });

    it('keeps accounts independent', () => {
        // A busy collaborator must not spend anyone else's allowance — the budget is per
        // person, exactly like the schedules and fitted weights it sits beside.
        consume('acct-a', 20, T0);
        assert.equal(check('acct-a', 1, LIMITS, T0).allowed, false);
        assert.equal(check('acct-b', 10, LIMITS, T0).allowed, true);
    });

    it('ignores a non-positive consume', () => {
        consume('acct-a', 0, T0);
        consume('acct-a', -5, T0);
        assert.equal(check('acct-a', 10, LIMITS, T0).used, 0);
    });

    it('treats a zero per-hour limit as closed rather than unlimited', () => {
        // Fails shut. A limit of zero is a deliberate lockdown, and reading it as
        // "no limit configured" would invert the operator's intent.
        const v = check('acct-a', 1, { perHour: 0, perRequest: 10 }, T0);
        assert.equal(v.allowed, false);
        assert.equal(v.reason, 'per_hour');
    });
});
