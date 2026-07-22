// Stats aggregation tests — exercises SRS.getStatistics() through the access layer
// against a real SQLite DB. Uses delta assertions (before/after) so it is robust
// to any data other test files leave in the shared dev vault.
// Standalone: node --test tests/stats.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import validate from '../src/api/config/validate.js';
import Documents from '../src/api/access/documents.js';
import SRS from '../src/api/access/srs.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/config.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const ROOT = 'StatsTestWorkspace';

const rmWorkspace = () => {
    try {
        const absPath = path.join(getWorkspacePath(), ROOT);
        if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
    } catch { /* ignore */ }
};

const scheduledTotal = (s) => s.overdue + s.forecast.reduce((a, f) => a + f.due, 0);
const todayUTC = () => new Date().toISOString().slice(0, 10);

describe('SRS statistics', () => {
    const docRel = path.join(ROOT, 'deck.md');
    const hashA = crypto.randomUUID();
    const hashB = crypto.randomUUID();

    before(async () => {
        rmWorkspace();
        await sealTools.init();
        await docs.createFolder(ROOT);
        await docs.importFile('deck.md', ROOT, Buffer.from('# Deck'), {
            globalHash: crypto.randomUUID(),
            flashcards: [
                { globalHash: hashA, level: 0, vanillaData: { frontText: 'Qa', backText: 'Aa' } },
                { globalHash: hashB, level: 0, vanillaData: { frontText: 'Qb', backText: 'Ab' } },
            ],
        });
    });

    after(() => rmWorkspace());

    it('returns a well-formed stats shape', () => {
        const s = SRS.getStatistics({ algorithm: 'leitner' });
        assert.equal(s.algorithm, 'leitner');
        assert.ok(s.totals && typeof s.totals.cards === 'number');
        assert.ok(s.acquisition && s.acquisition.learningReviews > 0);
        assert.ok(s.acquisition.reviewsToRecall && 'median' in s.acquisition.reviewsToRecall);
        assert.ok(s.maturity && ['new', 'young', 'mature'].every(k => k in s.maturity));
        assert.equal(s.forecast.length, 14);
        assert.ok(Array.isArray(s.activity));
        assert.ok(s.streak && typeof s.streak.current === 'number');
    });

    it('counts new cards and a review, and schedules the reviewed card', async () => {
        const before = SRS.getStatistics({ algorithm: 'leitner' });

        // Two freshly-imported cards are unreviewed ⇒ both "new".
        assert.ok(before.maturity.new >= 2, 'both new cards counted');

        // Review one card (Leitner: outcome/easeFactor/newLevel computed client-side).
        await docs.submitReview(docRel, hashA, 1, 2.5, 1, 'leitner');
        const after = SRS.getStatistics({ algorithm: 'leitner' });

        assert.equal(after.totals.cards - before.totals.cards, 0, 'no cards added by a review');
        assert.equal(after.totals.reviews - before.totals.reviews, 1, 'one more review logged');

        // The reviewed card leaves "new" and becomes "young" (level 1 ⇒ 1-day interval).
        assert.equal(after.maturity.new - before.maturity.new, -1);
        assert.equal(after.maturity.young - before.maturity.young, 1);

        // It is now scheduled (either upcoming in the forecast or overdue).
        assert.equal(scheduledTotal(after) - scheduledTotal(before), 1);

        // A card's first review is acquisition, not retention: it counts toward the
        // learning bucket and leaves the retention sample untouched.
        assert.equal(after.acquisition.reviews - before.acquisition.reviews, 1);
        assert.equal(after.totals.retentionReviews - before.totals.retentionReviews, 0);
        assert.equal(after.acquisition.firstExposureCards - before.acquisition.firstExposureCards, 1);

        const today = after.activity.find(a => a.day === todayUTC());
        assert.ok(today && today.total >= 1, 'today appears in the activity heatmap data');
        assert.ok(after.streak.current >= 1, 'a review today gives at least a 1-day streak');
    });

    it('counts a card toward retention only once it is past the learning phase', async () => {
        const before = SRS.getStatistics({ algorithm: 'leitner' });
        const n = before.acquisition.learningReviews;

        // hashA already has 1 review from the previous test. Take it to exactly n,
        // then one past it: only that last review is a retention-phase review.
        for (let i = 1; i < n; i++) {
            await docs.submitReview(docRel, hashA, 1, 2.5, i + 1, 'leitner');
        }
        const atThreshold = SRS.getStatistics({ algorithm: 'leitner' });
        assert.equal(atThreshold.acquisition.reviews - before.acquisition.reviews, n - 1,
            'reviews up to the threshold all land in the learning bucket');
        assert.equal(atThreshold.totals.retentionReviews - before.totals.retentionReviews, 0);

        await docs.submitReview(docRel, hashA, 1, 2.5, n + 1, 'leitner');
        const after = SRS.getStatistics({ algorithm: 'leitner' });
        assert.equal(after.acquisition.reviews - atThreshold.acquisition.reviews, 0,
            'past the threshold the learning bucket stops growing');
        assert.equal(after.totals.retentionReviews - atThreshold.totals.retentionReviews, 1);
        assert.ok(after.totals.retentionAll > 0 && after.totals.retentionAll <= 1,
            'retention is now measurable');
    });

    it('measures acquisition cost as attempts to the first correct recall', async () => {
        const before = SRS.getStatistics({ algorithm: 'leitner' });
        // Sum of attempts across cards — the exact quantity a delta can be read off,
        // unlike the vault-wide average/median.
        const attemptSum = (s) => (s.acquisition.reviewsToRecall.avg ?? 0) * s.acquisition.reviewsToRecall.cards;
        const firstCorrect = (s) => (s.acquisition.firstExposureAll ?? 0) * s.acquisition.firstExposureCards;

        // hashB: fail, fail, pass ⇒ learned on the 3rd attempt.
        await docs.submitReview(docRel, hashB, 0, 2.4, 1, 'leitner');
        await docs.submitReview(docRel, hashB, 0, 2.3, 1, 'leitner');

        const failing = SRS.getStatistics({ algorithm: 'leitner' });
        assert.equal(failing.acquisition.reviewsToRecall.cards - before.acquisition.reviewsToRecall.cards, 0,
            'a card never yet recalled contributes no acquisition-cost sample');
        assert.equal(Math.round(firstCorrect(failing) - firstCorrect(before)), 0,
            'a failed first exposure does not count as a first-sight recall');
        assert.equal(failing.acquisition.firstExposureCards - before.acquisition.firstExposureCards, 1);

        await docs.submitReview(docRel, hashB, 1, 2.4, 2, 'leitner');
        const after = SRS.getStatistics({ algorithm: 'leitner' });
        assert.equal(after.acquisition.reviewsToRecall.cards - failing.acquisition.reviewsToRecall.cards, 1);
        assert.equal(Math.round(attemptSum(after) - attemptSum(failing)), 3,
            'the card took three attempts before it was first recalled');
    });
});
