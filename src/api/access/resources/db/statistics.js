import db from '../../primitives/database.js';
import { CARD_LEARNED_SQL, PROGRESS_JOIN, scoped } from './sql.js';

export async function getLeitnerBoxes(scope) {
    return await db.prepare(`
        SELECT COALESCE(p.level, 0) AS level, COUNT(*) AS count
        FROM Flashcards f
        ${PROGRESS_JOIN()}
        GROUP BY COALESCE(p.level, 0)
        ORDER BY level ASC
    `).all(scoped(scope));
}

export async function getVaultLearned(scope) {
    const row = await db.prepare(`
        SELECT COUNT(*) AS cards,
               COALESCE(SUM(${CARD_LEARNED_SQL('p')}), 0) AS learnedSum
        FROM Flashcards f
        ${PROGRESS_JOIN()}
    `).get(scoped(scope));
    return { cards: row?.cards ?? 0, learnedSum: row?.learnedSum ?? 0 };
}

export async function getMasteredCount(threshold, scope) {
    return (await db.prepare(
        'SELECT COUNT(*) as c FROM progress.CardProgress WHERE account_id = ? AND level >= ?'
    ).get(scoped(scope), threshold)).c;
}

export async function getReviewActivity(sinceIso = null, scope) {
    const clause = sinceIso
        ? "WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') >= ?"
        : 'WHERE outcome IS NOT NULL AND account_id = ?';
    const stmt = db.prepare(`
        SELECT date(timestamp, 'localtime') AS day,
               COUNT(*) AS total,
               SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
        FROM progress.ReviewLogs
        ${clause}
        GROUP BY day
        ORDER BY day ASC
    `);
    const account = scoped(scope);
    return sinceIso ? await stmt.all(account, sinceIso) : await stmt.all(account);
}

export async function getReviewTotals(sinceIso = null, scope) {
    const clause = sinceIso
        ? "WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') >= ?"
        : 'WHERE outcome IS NOT NULL AND account_id = ?';
    const stmt = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
        FROM progress.ReviewLogs
        ${clause}
    `);
    const account = scoped(scope);
    return sinceIso ? await stmt.get(account, sinceIso) : await stmt.get(account);
}

function orderedReviewsCte() {
    return `
        WITH ordered AS (
            SELECT card_hash, outcome, timestamp,
                   ROW_NUMBER() OVER (
                       PARTITION BY card_hash ORDER BY timestamp ASC, id ASC
                   ) AS rep
            FROM progress.ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ?
        )
    `;
}

export async function getReviewTotalsByPhase(learningReviews, sinceIso = null, scope) {
    const stmt = db.prepare(`
        ${orderedReviewsCte()}
        SELECT CASE WHEN rep <= ? THEN 'learning' ELSE 'review' END AS phase,
               COUNT(*) AS total,
               SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
        FROM ordered
        ${sinceIso ? "WHERE date(timestamp, 'localtime') >= ?" : ''}
        GROUP BY phase
    `);
    const account = scoped(scope);
    const rows = sinceIso
        ? await stmt.all(account, learningReviews, sinceIso)
        : await stmt.all(account, learningReviews);
    const out = { learning: { total: 0, correct: 0 }, review: { total: 0, correct: 0 } };
    for (const r of rows) out[r.phase] = { total: r.total ?? 0, correct: r.correct ?? 0 };
    return out;
}

export async function getFirstExposureTotals(sinceIso = null, scope) {
    const stmt = db.prepare(`
        ${orderedReviewsCte()}
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
        FROM ordered
        WHERE rep = 1 ${sinceIso ? "AND date(timestamp, 'localtime') >= ?" : ''}
    `);
    const account = scoped(scope);
    const row = sinceIso ? await stmt.get(account, sinceIso) : await stmt.get(account);
    return { total: row?.total ?? 0, correct: row?.correct ?? 0 };
}

export async function getReviewsToFirstRecall(scope) {
    return await db.prepare(`
        ${orderedReviewsCte()}
        SELECT f.id AS flashcard_id, MIN(o.rep) AS attempts
        FROM ordered o
        JOIN Flashcards f ON f.global_hash = o.card_hash
        WHERE o.outcome = 1
        GROUP BY f.id
    `).all(scoped(scope));
}

export async function getDayReviewTotals(dayIso, scope) {
    return await db.prepare(`
        SELECT COUNT(*) AS reviews,
               COUNT(DISTINCT card_hash) AS uniqueCards,
               SUM(CASE WHEN outcome = 0 THEN 1 ELSE 0 END) AS failed
        FROM progress.ReviewLogs
        WHERE outcome IS NOT NULL AND account_id = ? AND date(timestamp, 'localtime') = ?
    `).get(scoped(scope), dayIso);
}

export async function getDayReviewTotalsByPhase(learningReviews, dayIso, scope) {
    const rows = await db.prepare(`
        ${orderedReviewsCte()}
        SELECT CASE WHEN rep <= ? THEN 'learning' ELSE 'review' END AS phase,
               COUNT(*) AS total,
               SUM(CASE WHEN outcome = 1 THEN 1 ELSE 0 END) AS correct
        FROM ordered
        WHERE date(timestamp, 'localtime') = ?
        GROUP BY phase
    `).all(scoped(scope), learningReviews, dayIso);
    const out = { learning: { total: 0, correct: 0 }, review: { total: 0, correct: 0 } };
    for (const r of rows) out[r.phase] = { total: r.total ?? 0, correct: r.correct ?? 0 };
    return out;
}

export async function getDayNewCards(dayIso, scope) {
    return (await db.prepare(`
        SELECT COUNT(*) AS newCards FROM (
            SELECT card_hash, MIN(date(timestamp, 'localtime')) AS firstDay
            FROM progress.ReviewLogs
            WHERE outcome IS NOT NULL AND account_id = ?
            GROUP BY card_hash
            HAVING firstDay = ?
        )
    `).get(scoped(scope), dayIso)).newCards;
}

export async function getDayByDeck(dayIso, scope) {
    return await db.prepare(`
        SELECT d.name AS deck,
               COUNT(*) AS reviews,
               SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failed
        FROM progress.ReviewLogs rl
        JOIN Flashcards f ON f.global_hash = rl.card_hash
        JOIN DeckEntries de ON de.card_hash = f.global_hash
        JOIN Decks d ON d.id = de.deck_id
        WHERE rl.outcome IS NOT NULL
          AND rl.account_id = ?
          AND date(rl.timestamp, 'localtime') = ?
          AND COALESCE(d.is_system, 0) = 0
        GROUP BY d.id
        ORDER BY reviews DESC, d.name ASC
    `).all(scoped(scope), dayIso);
}

export async function getDayByDocument(dayIso, scope) {
    return await db.prepare(`
        SELECT doc.relative_path AS path,
               COUNT(*) AS reviews,
               SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failed
        FROM progress.ReviewLogs rl
        JOIN Flashcards f ON f.global_hash = rl.card_hash
        JOIN Documents doc ON doc.id = f.document_id
        WHERE rl.outcome IS NOT NULL AND rl.account_id = ? AND date(rl.timestamp, 'localtime') = ?
        GROUP BY doc.id
        ORDER BY reviews DESC, doc.relative_path ASC
    `).all(scoped(scope), dayIso);
}

export async function getDayStruggledCards(dayIso, limit = 10, scope) {
    return await db.prepare(`
        SELECT f.global_hash AS globalHash,
               fc.frontText AS front,
               SUM(CASE WHEN rl.outcome = 0 THEN 1 ELSE 0 END) AS failCount
        FROM progress.ReviewLogs rl
        JOIN Flashcards f ON f.global_hash = rl.card_hash
        LEFT JOIN FlashcardContent fc ON fc.id = f.content_id
        WHERE rl.outcome IS NOT NULL AND rl.account_id = ? AND date(rl.timestamp, 'localtime') = ?
        GROUP BY f.id
        HAVING failCount > 0
        ORDER BY failCount DESC, f.id ASC
        LIMIT ?
    `).all(scoped(scope), dayIso, limit);
}

export async function getReviewActivityDays(scope) {
    return (await db.prepare(`
        SELECT date(timestamp, 'localtime') AS day
        FROM progress.ReviewLogs
        WHERE outcome IS NOT NULL AND account_id = ?
        GROUP BY day
        ORDER BY day ASC
    `).all(scoped(scope))).map(r => r.day);
}

export async function getAvgLevel(documentId, scope) {
    return await db.prepare(`
        SELECT AVG(COALESCE(p.level, 0)) as score
        FROM Flashcards f
        ${PROGRESS_JOIN()}
        WHERE f.document_id = ?
    `).get(scoped(scope), documentId);
}
