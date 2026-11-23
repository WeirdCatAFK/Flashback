import db from '../../primitives/database.js';
import { PROGRESS_JOIN, PROGRESS_KEYS, scoped } from './sql.js';

async function upsert(flashcardId, scope, state) {
    await db.prepare(`
        INSERT INTO progress.CardProgress
            (card_hash, account_id, level, sm2_reps, last_recall,
             fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses)
        VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, card_hash) DO UPDATE SET
            level = excluded.level, sm2_reps = excluded.sm2_reps,
            last_recall = excluded.last_recall,
            fsrs_stability = excluded.fsrs_stability, fsrs_difficulty = excluded.fsrs_difficulty,
            fsrs_due = excluded.fsrs_due, fsrs_state = excluded.fsrs_state,
            fsrs_reps = excluded.fsrs_reps, fsrs_lapses = excluded.fsrs_lapses
    `).run(
        flashcardId, scoped(scope),
        state.level ?? null, state.sm2_reps ?? 0, state.last_recall ?? null,
        state.fsrs_stability ?? null, state.fsrs_difficulty ?? null, state.fsrs_due ?? null,
        state.fsrs_state ?? 0, state.fsrs_reps ?? 0, state.fsrs_lapses ?? 0,
    );
}

export async function get(flashcardId, scope) {
    return await db.prepare(
        `SELECT * FROM progress.CardProgress WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`
    ).get(flashcardId, scoped(scope)) ?? null;
}

export async function remove(flashcardId, scope) {
    await db.prepare(
        `DELETE FROM progress.CardProgress WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`
    ).run(flashcardId, scoped(scope));
}

export async function write(flashcardId, scope, data) {
    if (!PROGRESS_KEYS.some(k => data[k] !== undefined)) return;

    const state = {
        level: data.level ?? null,
        sm2_reps: data.sm2Reps ?? 0,
        last_recall: data.lastRecall ?? null,
        fsrs_stability: data.fsrsStability ?? null,
        fsrs_difficulty: data.fsrsDifficulty ?? null,
        fsrs_due: data.fsrsDue ?? null,
        fsrs_state: data.fsrsState ?? 0,
        fsrs_reps: data.fsrsReps ?? 0,
        fsrs_lapses: data.fsrsLapses ?? 0,
    };
    const carriesState = (state.level ?? 0) !== 0 || state.sm2_reps !== 0 || state.last_recall != null
        || state.fsrs_stability != null || state.fsrs_due != null
        || state.fsrs_state !== 0 || state.fsrs_reps !== 0 || state.fsrs_lapses !== 0;

    if (!carriesState && !await get(flashcardId, scope)) return;
    await upsert(flashcardId, scope, state);
}

export async function setSrsState(id, level, sm2Reps, scope) {
    const current = await get(id, scope);
    await upsert(id, scope, { ...current, level, sm2_reps: sm2Reps });
}

export async function getAllSrsState(scope) {
    return await db.prepare(`
        SELECT f.global_hash, p.level, p.sm2_reps, p.last_recall,
               p.fsrs_stability, p.fsrs_due, p.fsrs_state
        FROM Flashcards f
        ${PROGRESS_JOIN()}
    `).all(scoped(scope));
}

export async function batchSetFsrsState(cards, scope) {
    const account = scoped(scope);
    const stmt = batchStatement(
        `level = excluded.level, last_recall = excluded.last_recall,
         fsrs_stability = excluded.fsrs_stability, fsrs_difficulty = excluded.fsrs_difficulty,
         fsrs_due = excluded.fsrs_due, fsrs_state = excluded.fsrs_state,
         fsrs_reps = excluded.fsrs_reps, fsrs_lapses = excluded.fsrs_lapses`,
        '?, COALESCE(p.sm2_reps, 0), ?, ?, ?, ?, ?, ?, ?');
    await db.transaction(async (rows) => {
        for (const c of rows) {
            await stmt.run(
                account, c.level ?? 0, c.lastRecall ?? null,
                c.fsrsStability ?? null, c.fsrsDifficulty ?? null, c.fsrsDue ?? null,
                c.fsrsState ?? 0, c.fsrsReps ?? 0, c.fsrsLapses ?? 0,
                account, c.global_hash,
            );
        }
    })(cards);
}

export async function getLatestEaseFactors(scope) {
    const account = scoped(scope);
    const rows = await db.prepare(`
        SELECT f.global_hash, lr.ease_factor
        FROM Flashcards f
        JOIN progress.ReviewLogs lr ON lr.card_hash = f.global_hash
        WHERE lr.account_id = ?
          AND lr.id IN (SELECT MAX(id) FROM progress.ReviewLogs WHERE account_id = ? GROUP BY card_hash)
    `).all(account, account);
    return new Map(rows.map(r => [r.global_hash, r.ease_factor]));
}

function batchStatement(assignments, selectColumns) {
    return db.prepare(`
        INSERT INTO progress.CardProgress
            (card_hash, account_id, level, sm2_reps, last_recall,
             fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state, fsrs_reps, fsrs_lapses)
        SELECT f.global_hash, ?, ${selectColumns}
        FROM Flashcards f
        LEFT JOIN progress.CardProgress p ON p.card_hash = f.global_hash AND p.account_id = ?
        WHERE f.global_hash = ?
        ON CONFLICT(account_id, card_hash) DO UPDATE SET ${assignments}
    `);
}

export async function batchSetSm2Reps(cards, scope) {
    const account = scoped(scope);
    const stmt = batchStatement('sm2_reps = excluded.sm2_reps',
        `p.level, ?, p.last_recall, p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
         COALESCE(p.fsrs_state, 0), COALESCE(p.fsrs_reps, 0), COALESCE(p.fsrs_lapses, 0)`);
    await db.transaction(async (rows) => {
        for (const c of rows) await stmt.run(account, c.sm2_reps, account, c.global_hash);
    })(cards);
}

export async function batchSetLeitnerLevel(cards, scope) {
    const account = scoped(scope);
    const stmt = batchStatement('level = excluded.level',
        `?, COALESCE(p.sm2_reps, 0), p.last_recall, p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
         COALESCE(p.fsrs_state, 0), COALESCE(p.fsrs_reps, 0), COALESCE(p.fsrs_lapses, 0)`);
    await db.transaction(async (rows) => {
        for (const c of rows) await stmt.run(account, c.level, account, c.global_hash);
    })(cards);
}

export async function updateReview(id, timestamp, newValue, algorithm = 'leitner', scope) {
    const current = await get(id, scope) ?? {};
    const next = { ...current, last_recall: timestamp };
    if (algorithm === 'sm2') next.sm2_reps = newValue;
    else next.level = newValue;
    await upsert(id, scope, next);
}

export async function getFsrsStatesByHash(hashes, scope) {
    const out = new Map();
    for (let i = 0; i < hashes.length; i += 500) {
        const chunk = hashes.slice(i, i + 500);
        const rows = await db.prepare(`
            SELECT card_hash, fsrs_stability AS stability, fsrs_difficulty AS difficulty,
                   fsrs_due AS due, fsrs_state AS state,
                   fsrs_reps AS reps, fsrs_lapses AS lapses, last_recall AS last_review
            FROM progress.CardProgress
            WHERE account_id = ? AND card_hash IN (${chunk.map(() => '?').join(', ')})
        `).all(scoped(scope), ...chunk);
        for (const r of rows) out.set(r.card_hash, r);
    }
    return out;
}

export async function getFsrsState(id, scope) {
    return await db.prepare(`
        SELECT fsrs_stability AS stability, fsrs_difficulty AS difficulty,
               fsrs_due AS due, fsrs_state AS state,
               fsrs_reps AS reps, fsrs_lapses AS lapses, last_recall AS last_review
        FROM progress.CardProgress WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?
    `).get(id, scoped(scope)) ?? null;
}

export async function updateFsrs(id, s, scope) {
    const current = await get(id, scope) ?? {};
    await upsert(id, scope, {
        ...current,
        last_recall: s.last_review,
        level: s.level ?? 0,
        fsrs_stability: s.stability,
        fsrs_difficulty: s.difficulty,
        fsrs_due: s.due,
        fsrs_state: s.state,
        fsrs_reps: s.reps,
        fsrs_lapses: s.lapses,
    });
}

export async function getSrsStateByHash(hash, scope) {
    const account = scoped(scope);
    return await db.prepare(`
        SELECT f.id, f.global_hash,
               COALESCE(p.level, 0) AS level, COALESCE(p.sm2_reps, 0) AS sm2_reps,
               p.last_recall, p.fsrs_stability, p.fsrs_difficulty,
               COALESCE(p.fsrs_state, 0) AS fsrs_state, p.fsrs_due,
               COALESCE(p.fsrs_reps, 0) AS fsrs_reps, COALESCE(p.fsrs_lapses, 0) AS fsrs_lapses,
               (SELECT rl.ease_factor FROM progress.ReviewLogs rl
                 WHERE rl.card_hash = f.global_hash AND rl.account_id = ?
                 ORDER BY rl.id DESC LIMIT 1) AS ease_factor
        FROM Flashcards f
        ${PROGRESS_JOIN()}
        WHERE f.global_hash = ?
    `).get(account, account, hash);
}

export async function undoReview(id, value, lastRecall, algorithm = 'leitner', scope) {
    const current = await get(id, scope) ?? {};
    const next = { ...current, last_recall: lastRecall };
    if (algorithm === 'sm2') next.sm2_reps = value;
    else next.level = value;
    await upsert(id, scope, next);
}

export async function hasForHash(cardHash, scope) {
    const row = await db.prepare(
        'SELECT 1 AS present FROM progress.CardProgress WHERE card_hash = ? AND account_id = ?',
    ).get(cardHash, scoped(scope));
    return !!row;
}

export async function seedEaseFromSidecar(cardHash, easeFactor, level) {
    await db.prepare(`
        INSERT INTO progress.ReviewLogs (card_hash, account_id, timestamp, outcome, ease_factor, level)
        SELECT ?, 'owner', datetime('now'), NULL, ?, ?
        WHERE NOT EXISTS (
            SELECT 1 FROM progress.ReviewLogs WHERE card_hash = ? AND account_id = 'owner'
        )
    `).run(cardHash, easeFactor, level ?? 0, cardHash);
}

export async function purgeCardBehaviour(cardHash) {
    for (const table of ['CardProgress', 'CardHealth', 'CardFlags', 'ReviewLogs']) {
        await db.prepare(`DELETE FROM progress.${table} WHERE card_hash = ?`).run(cardHash);
    }
}
