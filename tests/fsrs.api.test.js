// FSRS integration tests — exercises the review loop through the access layer
// (migration → submit → due → undo) against a real SQLite DB.
// Run after `npm run tests` has built better-sqlite3 for system Node, or via the
// full suite. Standalone: node --test tests/fsrs.api.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import validate from '../src/api/config/validate.js';
import Documents from '../src/api/access/orchestration/documents.js';
import db from '../src/api/access/primitives/database.js';
import query from '../src/api/access/resources/query.js';
import SRS from '../src/api/access/orchestration/srs.js';
import * as fsrs from '../src/api/access/orchestration/fsrs.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/primitives/config.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const ROOT = 'FsrsTestWorkspace';
const docRel = path.join(ROOT, 'deck.md');

const rmWorkspace = () => {
    try {
        const absPath = path.join(getWorkspacePath(), ROOT);
        if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
    } catch { /* ignore */ }
};

describe('FSRS review loop', () => {
    let hash;

    before(async () => {
        rmWorkspace();
        await sealTools.init();
        await docs.createFolder(ROOT);
        hash = crypto.randomUUID();
        await docs.importFile('deck.md', ROOT, Buffer.from('# Deck'), {
            globalHash: crypto.randomUUID(),
            flashcards: [{ globalHash: hash, level: 0, vanillaData: { frontText: 'Q', backText: 'A' } }],
        });
    });

    after(() => rmWorkspace());

    // The card's schedule moved to CardProgress in migration 010: it belongs to a person,
    // not to the card. These tests are the owner's, so they read the owner's row.
    const cardRow = async () => await db.prepare(`
        SELECT f.id, f.global_hash, p.level, p.sm2_reps, p.last_recall,
               p.fsrs_stability, p.fsrs_difficulty, p.fsrs_due,
               p.fsrs_state, p.fsrs_reps, p.fsrs_lapses
        FROM Flashcards f
        LEFT JOIN CardProgress p ON p.flashcard_id = f.id AND p.account_id = 'owner'
        WHERE f.global_hash = ?
    `).get(hash);

    it('schema migration added the FSRS columns and FsrsParameters table', async () => {
        const cols = (await await db.prepare("PRAGMA table_info('CardProgress')").all()).map(c => c.name);
        for (const c of ['fsrs_stability', 'fsrs_difficulty', 'fsrs_due', 'fsrs_state', 'fsrs_reps', 'fsrs_lapses']) {
            assert.ok(cols.includes(c), `CardProgress should have ${c}`);
        }
        assert.ok(cols.includes('account_id'), 'CardProgress should be keyed by account');
        const rlCols = (await await db.prepare("PRAGMA table_info('ReviewLogs')").all()).map(c => c.name);
        assert.ok(rlCols.includes('rating'));
        const tbl = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='FsrsParameters'").get();
        assert.ok(tbl, 'FsrsParameters table should exist');
    });

    it('a first FSRS review populates stability/difficulty/due and logs the rating', async () => {
        await docs.submitReview(docRel, hash, null, null, null, 'fsrs', { rating: 3, requestRetention: 0.9 });
        const c = await cardRow();
        assert.ok(c.fsrs_stability > 0, 'stability set');
        assert.ok(c.fsrs_difficulty >= 1 && c.fsrs_difficulty <= 10, 'difficulty in range');
        assert.ok(c.fsrs_due, 'due set');
        assert.equal(c.fsrs_state, 2, 'state = review');
        assert.equal(c.fsrs_reps, 1);
        // The app-wide `level` scalar must track FSRS strength so level-based UI
        // (LevelDot, box histogram, mastery counts) works under FSRS.
        assert.ok(c.level >= 1, 'level derived from the FSRS interval');

        const log = await db.prepare('SELECT * FROM ReviewLogs WHERE flashcard_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
        assert.equal(log.rating, 3);
        assert.equal(log.outcome, 1);
        assert.ok(log.fsrs_stability > 0, 'log snapshots stability');
        assert.equal(log.level, c.level, 'log snapshots the derived level for undo');
    });

    it('the sidecar mirrors the FSRS state', () => {
        const meta = docs.files.getMetadata(docRel);
        const card = meta.flashcards.find(f => f.globalHash === hash);
        assert.ok(card.fsrsStability > 0);
        assert.equal(card.fsrsState, 2);
        assert.ok(card.fsrsDue);
        assert.ok(card.level >= 1, 'sidecar mirrors the derived level');
    });

    it('getDue keys due-ness off fsrs_due, not the interval formula', async () => {
        // Card was just reviewed with a multi-day interval, so it is neither due nor new.
        const res = await query.getDueFlashcards({ algorithm: 'fsrs', maxNew: 20 }, 'owner');
        const inDue = res.due.some(r => r.global_hash === hash);
        const inNew = res.newCards.some(r => r.global_hash === hash);
        assert.equal(inDue, false, 'freshly reviewed card is not due');
        assert.equal(inNew, false, 'reviewed card is not new');
    });

    it('nextDue is a valid SQLite-format datetime, not a raw ISO string (NaN-days bug)', async () => {
        const res = await query.getDueFlashcards({ algorithm: 'fsrs', maxNew: 20 }, 'owner');
        assert.ok(res.nextDue, 'the future card sets nextDue');
        // Must be "YYYY-MM-DD HH:MM:SS" (no T/Z) so the frontend can parse it.
        assert.ok(!res.nextDue.includes('T') && !res.nextDue.includes('Z'), `got ${res.nextDue}`);
        const parsed = new Date(res.nextDue.replace(' ', 'T') + 'Z');
        assert.ok(!Number.isNaN(parsed.getTime()), 'nextDue parses to a real date');
    });

    it('optimizeParameters keeps defaults (and does not persist) below the data threshold', async () => {
        const info = await SRS.getFsrsInfo();
        assert.ok(info.reviewCount < info.minReviews, 'test vault has < 400 rated reviews');
        const res = await SRS.optimizeParameters();
        assert.equal(res.optimized, false);
        assert.equal(res.reason, 'insufficient-data');
        // Nothing was written, so the vault is still on default (unfitted) weights.
        assert.equal(await query.getFsrsWeights('owner'), null, 'no FsrsParameters row persisted');
        assert.equal(info.optimized, false);
    });

    it('the card curve is the same model that scheduled the card', async () => {
        // The claim the card detail view makes about an FSRS card is that its curve
        // is not an illustration: it's retrievability() on the card's own stability
        // with the vault's weights. So the curve must cross the request retention
        // exactly where FSRS put the due date.
        const insights = await SRS.getCardInsights(hash, { algorithm: 'fsrs' });
        assert.equal(insights.curve.model, 'fsrs');
        assert.equal(insights.curve.stabilityDays, (await cardRow()).fsrs_stability);

        const target = insights.curve.requestRetention;
        const dueT = fsrs.intervalFromStability(insights.curve.stabilityDays, target, await SRS.getWeights());
        const r = fsrs.retrievability(dueT, insights.curve.stabilityDays, await SRS.getWeights());
        assert.ok(Math.abs(r - target) < 0.02, `retention at the due date should be ~${target}, got ${r}`);
        assert.ok(Math.abs(insights.curve.intervalDays - dueT) < 0.51,
            'the drawn due marker is the interval FSRS actually scheduled');
        assert.equal(insights.curve.points.at(-1).t, insights.curve.horizonDays);
    });

    it('undo restores the prior FSRS state (back to new after the only review)', async () => {
        await docs.undoReview(docRel, hash, 'fsrs');
        const c = await cardRow();
        assert.equal(c.fsrs_state, 0, 'reverted to new');
        assert.equal(c.fsrs_stability, null, 'stability cleared');
        assert.equal(c.level, 0, 'level reverted to new');
        const logs = await db.prepare('SELECT COUNT(*) AS n FROM ReviewLogs WHERE flashcard_id = ?').get(c.id);
        assert.equal(logs.n, 0, 'review log removed');
    });
});
