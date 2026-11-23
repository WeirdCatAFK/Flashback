/**
 * Limits how many cards a collaborator deletes per request and per hour.
 * shortcut: the counter lives in this process and resets on restart. Move it to the accounts store if the limit must survive a restart.
 */
const WINDOW_MS = 60 * 60 * 1000;

const removals = new Map();

function prune(accountId, now) {
    const entries = removals.get(accountId);
    if (!entries) return [];

    const cutoff = now - WINDOW_MS;
    const live = entries.filter((e) => e.at > cutoff);
    if (live.length === 0) removals.delete(accountId);
    else removals.set(accountId, live);
    return live;
}

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

export function consume(accountId, count, now = Date.now()) {
    if (!(count > 0)) return;
    const live = prune(accountId, now);
    live.push({ at: now, count });
    removals.set(accountId, live);
}

export function reset() {
    removals.clear();
}

export default { check, consume, reset };
