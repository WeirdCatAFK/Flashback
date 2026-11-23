import db from '../../primitives/database.js';
import { OWNER_SCOPE } from '../../../requestContext.js';
import { scoped } from './sql.js';

export async function get(flashcardId, scope) {
    return await db.prepare(
        `SELECT * FROM progress.CardHealth WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`
    ).get(flashcardId, scoped(scope)) ?? null;
}

export async function upsert(flashcardId, { epochAt = null, epochReason = null, contentFingerprint = null }, scope) {
    return await db.prepare(`
        INSERT INTO progress.CardHealth (card_hash, account_id, epoch_at, epoch_reason, content_fingerprint, updated_at)
        VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, card_hash) DO UPDATE SET
            epoch_at            = excluded.epoch_at,
            epoch_reason        = excluded.epoch_reason,
            content_fingerprint = excluded.content_fingerprint,
            updated_at          = excluded.updated_at
    `).run(flashcardId, scoped(scope), epochAt, epochReason, contentFingerprint, new Date().toISOString());
}

export async function setFingerprint(flashcardId, contentFingerprint, scope) {
    return await db.prepare(
        `UPDATE progress.CardHealth SET content_fingerprint = ?, updated_at = ? WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`
    ).run(contentFingerprint, new Date().toISOString(), flashcardId, scoped(scope));
}

export async function getFlags(flashcardId, { includeDismissed = false } = {}, scope) {
    const filter = includeDismissed ? '' : ' AND dismissed_at IS NULL';
    return await db.prepare(
        `SELECT * FROM progress.CardFlags WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?${filter} ORDER BY detected_at DESC`
    ).all(flashcardId, scoped(scope));
}

export async function upsertFlag({ flashcardId, kind, confidence, score, evidence, levelAtDetection, reviewLogId }, scope) {
    return await db.prepare(`
        INSERT INTO progress.CardFlags
            (card_hash, account_id, kind, confidence, score, evidence_json,
             level_at_detection, detected_at, review_log_id, dismissed_at)
        VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(account_id, card_hash, kind) DO UPDATE SET
            confidence         = excluded.confidence,
            score              = excluded.score,
            evidence_json      = excluded.evidence_json,
            level_at_detection = excluded.level_at_detection,
            detected_at        = excluded.detected_at,
            review_log_id      = excluded.review_log_id
    `).run(
        flashcardId, scoped(scope), kind, confidence, score ?? null,
        evidence ? JSON.stringify(evidence) : null,
        levelAtDetection ?? null, new Date().toISOString(), reviewLogId ?? null,
    );
}

export async function deleteFlags(flashcardId, { kinds = null, includeDismissed = false } = {}, scope) {
    const params = [flashcardId, scoped(scope)];
    let sql = `DELETE FROM progress.CardFlags WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ?`;
    if (!includeDismissed) sql += ' AND dismissed_at IS NULL';
    if (kinds?.length) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
    }
    return (await db.prepare(sql).run(...params)).changes;
}

export async function deleteAllFlags(flashcardId) {
    return (await db.prepare(`DELETE FROM progress.CardFlags WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?)`).run(flashcardId)).changes;
}

export async function resetAll(flashcardId, { epochAt, epochReason, contentFingerprint }) {
    const changed = (await db.prepare(`
        UPDATE progress.CardHealth SET epoch_at = ?, epoch_reason = ?, content_fingerprint = ?, updated_at = ?
        WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?)
    `).run(epochAt, epochReason, contentFingerprint, new Date().toISOString(), flashcardId)).changes;
    if (changed === 0) {
        await upsert(flashcardId, { epochAt, epochReason, contentFingerprint }, OWNER_SCOPE);
    }
    return changed;
}

export async function dismissFlag(flashcardId, kind, scope) {
    return (await db.prepare(
        `UPDATE progress.CardFlags SET dismissed_at = ? WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND account_id = ? AND kind = ?`
    ).run(new Date().toISOString(), flashcardId, scoped(scope), kind)).changes;
}
