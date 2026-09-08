/**
 * How many flashcards one account may delete in an hour.
 *
 * ## The hole this covers
 *
 * `PUT /api/documents/metadata` is a COLLABORATOR route, and deliberately so: highlights,
 * tags and cards all live in the sidecar, so a collaborator who could not write metadata
 * could not annotate anything. But the write is a whole-object replacement —
 * `files.writeMetadata` puts the caller's JSON on disk verbatim — and
 * `documents._syncDocumentFlashcards` then deletes every indexed card whose `globalHash` is
 * absent from what arrived. `{"flashcards": []}` therefore erased a document's entire card
 * set, canonical file and index together, in one request from the role that is supposed to
 * be able to annotate but not to reshape the vault.
 *
 * ## Why a budget rather than a role check
 *
 * Removing a card IS part of annotating — a collaborator tidying up their own cards is the
 * normal case, and gating it behind admin would make the role useless for the work it
 * exists to do. What is not normal is removing forty of them at once. So the operation
 * stays open and the VOLUME is bounded: enough headroom for real editing, nowhere near
 * enough to clear a vault before someone notices.
 *
 * Two limits, because they stop different things:
 *
 *   - **per request** — the one that matters. It is what makes "delete this document's two
 *     hundred cards in a single call" impossible, which is the actual attack. An hourly
 *     budget alone would wave the first such request straight through on a fresh window.
 *   - **per rolling hour** — bounds the damage from a patient caller, and turns a silent
 *     instant wipe into something slow enough to see.
 *
 * ## What it is NOT
 *
 * This is a rate limit, not an authorization boundary, and reading it as one would be a
 * mistake. Twenty an hour is still four hundred and eighty a day: a determined collaborator
 * can eventually erase a vault, and nothing here prevents that. What it buys is that no
 * single request destroys a document, the loss per hour is bounded, and — because every
 * metadata write is a Seal commit — the Author can roll the whole thing back. The
 * authorization boundary is still the role table; this only stops that boundary's one
 * deliberately-wide door from being a trapdoor.
 *
 * Admins and the Author are exempt, because clearing a document IS their prerogative and
 * they are precisely who the plan reserves a full wipe for.
 *
 * ## Scope, stated plainly
 *
 * **The counter lives in this process and resets when it restarts.** Same honesty as
 * `pathLock.js`: one API process per vault is the deployment model, so this is the right
 * scope, but it is not a durable quota and must not be sold as one. A caller who can
 * restart the server can clear their own budget — and a caller who can restart the server
 * did not need this budget defeated to begin with.
 *
 * Pure: no config, no database, no filesystem, no imports beyond none at all — so
 * `tests/cardRemovalBudget.test.js` runs with no vault and no native module, like
 * `sequencing.js` and `safeFetch.js`.
 */

/** Length of the rolling window. */
const WINDOW_MS = 60 * 60 * 1000;

/**
 * accountId → array of `{ at, count }`, oldest first.
 *
 * @type {Map<string, Array<{ at: number, count: number }>>}
 */
const removals = new Map();

/** Drops entries that have aged out, and the account's slot with them once it is empty. */
function prune(accountId, now) {
    const entries = removals.get(accountId);
    if (!entries) return [];

    const cutoff = now - WINDOW_MS;
    const live = entries.filter((e) => e.at > cutoff);
    if (live.length === 0) removals.delete(accountId);
    else removals.set(accountId, live);
    return live;
}

/**
 * Whether this account may remove `count` more cards right now.
 *
 * @param {string} accountId
 * @param {number} count how many cards this request would remove.
 * @param {{ perHour: number, perRequest: number }} limits
 * @param {number} [now] injectable clock, for tests.
 * @returns {{ allowed: boolean, used: number, remaining: number, resetAt: number|null, retryAfter: number, reason: 'per_request'|'per_hour'|null }} `resetAt` is an epoch-ms timestamp: when the oldest counted removal ages out and some budget comes back. Null when nothing is currently counted.
 */
export function check(accountId, count, limits, now = Date.now()) {
    const perHour = Math.max(0, Number(limits?.perHour ?? 0));
    const perRequest = Math.max(0, Number(limits?.perRequest ?? 0));

    const live = prune(accountId, now);
    const used = live.reduce((sum, e) => sum + e.count, 0);
    const remaining = Math.max(0, perHour - used);
    const resetAt = live.length ? live[0].at + WINDOW_MS : null;
    const retryAfter = resetAt ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 0;

    if (count > perRequest) {
        return { allowed: false, used, remaining, resetAt, retryAfter, reason: 'per_request' };
    }
    if (count > remaining) {
        return { allowed: false, used, remaining, resetAt, retryAfter, reason: 'per_hour' };
    }
    return { allowed: true, used, remaining, resetAt, retryAfter: 0, reason: null };
}

/**
 * Records `count` removals against this account.
 *
 * @param {string} accountId
 * @param {number} count
 * @param {number} [now] injectable clock, for tests.
 */
export function consume(accountId, count, now = Date.now()) {
    if (!(count > 0)) return;
    const live = prune(accountId, now);
    live.push({ at: now, count });
    removals.set(accountId, live);
}

/** Forgets every account's history. A test hook; nothing in the app calls it. */
export function reset() {
    removals.clear();
}

export default { check, consume, reset };
