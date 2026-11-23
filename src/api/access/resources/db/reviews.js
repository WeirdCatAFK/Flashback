import db from '../../primitives/database.js';
import { scoped } from './sql.js';

export async function insertLog(data) {
    await db.prepare(`
        INSERT INTO progress.ReviewLogs
            (card_hash, account_id, timestamp, outcome, ease_factor, level, algorithm,
             rating, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state,
             session_id, session_position, prev_distance, nearest_sibling_lag)
        VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        data.flashcardId, scoped(data.accountId), data.timestamp, data.outcome, data.easeFactor, data.level,
        data.algorithm ?? null,
        data.rating ?? null,
        data.fsrsStability ?? null,
        data.fsrsDifficulty ?? null,
        data.fsrsDue ?? null,
        data.fsrsState ?? null,
        data.sessionId ?? null,
        data.sessionPosition ?? null,
        data.prevDistance ?? null,
        data.nearestSiblingLag ?? null,
    );
}

export async function getLatestAlgorithm(scope) {
    return await db.prepare(`
        SELECT algorithm, rating
        FROM progress.ReviewLogs
        WHERE outcome IS NOT NULL AND account_id = ?
        ORDER BY timestamp DESC, id DESC
        LIMIT 1
    `).get(scoped(scope)) ?? null;
}

export async function getFsrsWeights(scope) {
    const row = await db.prepare(
        'SELECT weights_json, review_count, optimized_at FROM progress.FsrsParameters WHERE account_id = ?'
    ).get(scoped(scope));
    if (!row) return null;
    return {
        weights: JSON.parse(row.weights_json),
        reviewCount: row.review_count,
        optimizedAt: row.optimized_at,
    };
}

export async function setFsrsWeights(weightsJson, reviewCount, scope) {
    await db.prepare(`
        INSERT INTO progress.FsrsParameters (account_id, weights_json, optimized_at, review_count)
        VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(account_id) DO UPDATE SET
            weights_json = excluded.weights_json,
            optimized_at = excluded.optimized_at,
            review_count = excluded.review_count
    `).run(scoped(scope), weightsJson, reviewCount);
}

export async function getAllHistories(scope) {
    return await db.prepare(`
        SELECT f.id AS flashcard_id, rl.timestamp, rl.rating
        FROM progress.ReviewLogs rl
        JOIN Flashcards f ON f.global_hash = rl.card_hash
        WHERE rl.rating IS NOT NULL AND rl.account_id = ?
        ORDER BY f.id ASC, rl.id ASC
    `).all(scoped(scope));
}

export async function deleteLatestLog(flashcardId, scope) {
    const row = await db.prepare(
        'SELECT id FROM progress.ReviewLogs WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ? ORDER BY id DESC LIMIT 1'
    ).get(flashcardId, scoped(scope));
    if (!row) return false;
    await db.prepare('DELETE FROM progress.ReviewLogs WHERE id = ?').run(row.id);
    return true;
}

export async function getCardHistory(flashcardId, scope) {
    return await db.prepare(`
        SELECT id, timestamp, outcome, ease_factor, level, algorithm, rating,
               fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
        FROM progress.ReviewLogs
        WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?
        ORDER BY id ASC
    `).all(flashcardId, scoped(scope));
}

export async function getLatestLog(flashcardId, scope) {
    return await db.prepare(`
        SELECT timestamp, outcome, ease_factor, level,
               rating, fsrs_stability, fsrs_difficulty, fsrs_due, fsrs_state
        FROM progress.ReviewLogs WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ? ORDER BY id DESC LIMIT 1
    `).get(flashcardId, scoped(scope)) ?? null;
}

export async function getRecentSessionRows(since, scope) {
    return await db.prepare(`
        SELECT rl.id, f.id AS flashcard_id, rl.timestamp, rl.outcome
        FROM progress.ReviewLogs rl
        JOIN Flashcards f ON f.global_hash = rl.card_hash
        WHERE rl.outcome IS NOT NULL AND rl.account_id = ? AND rl.timestamp >= ?
        ORDER BY rl.timestamp ASC, rl.id ASC
    `).all(scoped(scope), since);
}
