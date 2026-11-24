import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import validate from '../../src/api/config/validate.js';
import * as Documents from '../../src/api/access/modules/documents.js';
import * as Srs from '../../src/api/access/modules/srs.js';
import * as flashcardRows from '../../src/api/access/resources/db/flashcards.js';
import * as statisticsRows from '../../src/api/access/resources/db/statistics.js';
import db from '../../src/api/access/primitives/database.js';
import { sealTools } from '../../src/api/seal/seal.js';
import { getWorkspacePath } from '../../src/api/access/primitives/config.js';
import { testDataDir } from '../support/testData.js';

process.env.USER_DATA_PATH = testDataDir('stats');

if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const ROOT = 'StatsTestWorkspace';

const rmWorkspace = () => {
    try {
        const absPath = path.join(getWorkspacePath(), ROOT);
        if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
    } catch {  }
};

const scheduledTotal = (s) => s.overdue + s.forecast.reduce((a, f) => a + f.due, 0);
const todayLocal = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

describe('SRS statistics', () => {
    const docRel = path.join(ROOT, 'deck.md');
    const hashA = crypto.randomUUID();
    const hashB = crypto.randomUUID();

    before(async () => {
        rmWorkspace();
        await sealTools.init();
        await Documents.createFolder(ROOT);
        await Documents.importFile('deck.md', ROOT, Buffer.from('# Deck'), {
            globalHash: crypto.randomUUID(),
            flashcards: [
                { globalHash: hashA, level: 0, vanillaData: { frontText: 'Qa', backText: 'Aa' } },
                { globalHash: hashB, level: 0, vanillaData: { frontText: 'Qb', backText: 'Ab' } },
            ],
        });
    });

    after(() => rmWorkspace());

    it('returns a well-formed stats shape', async () => {
        const s = await Srs.getStatistics({ algorithm: 'leitner' });
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
        const before = await Srs.getStatistics({ algorithm: 'leitner' });

        assert.ok(before.maturity.new >= 2, 'both new cards counted');

        await Documents.submitReview(docRel, hashA, 1, 2.5, 1, 'leitner');
        const after = await Srs.getStatistics({ algorithm: 'leitner' });

        assert.equal(after.totals.cards - before.totals.cards, 0, 'no cards added by a review');
        assert.equal(after.totals.reviews - before.totals.reviews, 1, 'one more review logged');

        assert.equal(after.maturity.new - before.maturity.new, -1);
        assert.equal(after.maturity.young - before.maturity.young, 1);

        assert.equal(scheduledTotal(after) - scheduledTotal(before), 1);

        assert.equal(after.acquisition.reviews - before.acquisition.reviews, 1);
        assert.equal(after.totals.retentionReviews - before.totals.retentionReviews, 0);
        assert.equal(after.acquisition.firstExposureCards - before.acquisition.firstExposureCards, 1);

        const today = after.activity.find(a => a.day === todayLocal());
        assert.ok(today && today.total >= 1, 'today appears in the activity heatmap data');
        assert.ok(after.streak.current >= 1, 'a review today gives at least a 1-day streak');
    });

    it('counts a card toward retention only once it is past the learning phase', async () => {
        const before = await Srs.getStatistics({ algorithm: 'leitner' });
        const n = before.acquisition.learningReviews;

        for (let i = 1; i < n; i++) {
            await Documents.submitReview(docRel, hashA, 1, 2.5, i + 1, 'leitner');
        }
        const atThreshold = await Srs.getStatistics({ algorithm: 'leitner' });
        assert.equal(atThreshold.acquisition.reviews - before.acquisition.reviews, n - 1,
            'reviews up to the threshold all land in the learning bucket');
        assert.equal(atThreshold.totals.retentionReviews - before.totals.retentionReviews, 0);

        await Documents.submitReview(docRel, hashA, 1, 2.5, n + 1, 'leitner');
        const after = await Srs.getStatistics({ algorithm: 'leitner' });
        assert.equal(after.acquisition.reviews - atThreshold.acquisition.reviews, 0,
            'past the threshold the learning bucket stops growing');
        assert.equal(after.totals.retentionReviews - atThreshold.totals.retentionReviews, 1);
        assert.ok(after.totals.retentionAll > 0 && after.totals.retentionAll <= 1,
            'retention is now measurable');
    });

    it('measures acquisition cost as attempts to the first correct recall', async () => {
        const before = await Srs.getStatistics({ algorithm: 'leitner' });
        const attemptSum = (s) => (s.acquisition.reviewsToRecall.avg ?? 0) * s.acquisition.reviewsToRecall.cards;
        const firstCorrect = (s) => (s.acquisition.firstExposureAll ?? 0) * s.acquisition.firstExposureCards;

        await Documents.submitReview(docRel, hashB, 0, 2.4, 1, 'leitner');
        await Documents.submitReview(docRel, hashB, 0, 2.3, 1, 'leitner');

        const failing = await Srs.getStatistics({ algorithm: 'leitner' });
        assert.equal(failing.acquisition.reviewsToRecall.cards - before.acquisition.reviewsToRecall.cards, 0,
            'a card never yet recalled contributes no acquisition-cost sample');
        assert.equal(Math.round(firstCorrect(failing) - firstCorrect(before)), 0,
            'a failed first exposure does not count as a first-sight recall');
        assert.equal(failing.acquisition.firstExposureCards - before.acquisition.firstExposureCards, 1);

        await Documents.submitReview(docRel, hashB, 1, 2.4, 2, 'leitner');
        const after = await Srs.getStatistics({ algorithm: 'leitner' });
        assert.equal(after.acquisition.reviewsToRecall.cards - failing.acquisition.reviewsToRecall.cards, 1);
        assert.equal(Math.round(attemptSum(after) - attemptSum(failing)), 3,
            'the card took three attempts before it was first recalled');
    });
});


describe('SRS algorithm detection', () => {
    const ROOT2 = 'AlgoDetectWorkspace';
    const docRel = path.join(ROOT2, 'deck.md');
    const hashL = crypto.randomUUID();
    const hashF = crypto.randomUUID();

    const rm2 = () => {
        try {
            const abs = path.join(getWorkspacePath(), ROOT2);
            if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        } catch {  }
    };

    before(async () => {
        rm2();
        await sealTools.init();
        await Documents.createFolder(ROOT2);
        await Documents.importFile('deck.md', ROOT2, Buffer.from('# Deck'), {
            globalHash: crypto.randomUUID(),
            flashcards: [
                { globalHash: hashL, level: 0, vanillaData: { frontText: 'Ql', backText: 'Al' } },
                { globalHash: hashF, level: 0, vanillaData: { frontText: 'Qf', backText: 'Af' } },
            ],
        });
    });

    after(() => rm2());

    it('reports the algorithm of the most recent review', async () => {
        await Documents.submitReview(docRel, hashL, 1, 2.5, 1, 'leitner');
        assert.equal(await Srs.detectAlgorithm(), 'leitner');

        await Documents.submitReview(docRel, hashF, null, null, null, 'fsrs', { rating: 3 });
        assert.equal(await Srs.detectAlgorithm(), 'fsrs',
            'switching to FSRS must be visible to the server without being told');

        await Documents.submitReview(docRel, hashL, 1, 2.6, 2, 'sm2');
        assert.equal(await Srs.detectAlgorithm(), 'sm2',
            'sm2 is distinguishable from leitner now that the log records it');
    });

    it('getStatistics with no algorithm uses the detected one, not a hardcoded default', async () => {
        await Documents.submitReview(docRel, hashF, null, null, null, 'fsrs', { rating: 3 });
        assert.equal(await Srs.detectAlgorithm(), 'fsrs');

        const inferred = await Srs.getStatistics();
        assert.equal(inferred.algorithm, 'fsrs',
            'an MCP client reading `algorithm` back must not be told "leitner"');

        assert.equal((await Srs.getStatistics({ algorithm: 'sm2' })).algorithm, 'sm2');
    });

    it('getDue with no algorithm uses the detected one', async () => {
        assert.equal(await Srs.detectAlgorithm(), 'fsrs');
        assert.equal((await Srs.getDue({ folder: ROOT2 })).algorithm, 'fsrs');
        assert.equal((await Srs.getDue({ folder: ROOT2, algorithm: 'leitner' })).algorithm, 'leitner');
    });
});


describe('Card insights', () => {
    const ROOT3 = 'CardInsightsWorkspace';
    const docRel = path.join(ROOT3, 'deck.md');
    const hashC = crypto.randomUUID();

    const rm3 = () => {
        try {
            const abs = path.join(getWorkspacePath(), ROOT3);
            if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        } catch {  }
    };

    before(async () => {
        rm3();
        await sealTools.init();
        await Documents.createFolder(ROOT3);
        await Documents.importFile('deck.md', ROOT3, Buffer.from('# Deck'), {
            globalHash: crypto.randomUUID(),
            flashcards: [
                { globalHash: hashC, level: 0, vanillaData: { frontText: 'Qc', backText: 'Ac' } },
            ],
        });
    });

    after(() => rm3());

    it('separates real reviews from rows a vault rebuild synthesised', async () => {
        await Documents.submitReview(docRel, hashC, 1, 2.5, 1, 'leitner');
        await Documents.submitReview(docRel, hashC, 0, 2.4, 1, 'leitner');

        await db.prepare(`
            INSERT INTO progress.ReviewLogs (card_hash, account_id, timestamp, outcome, ease_factor, level)
            VALUES (?, 'owner', datetime('now'), NULL, 2.5, 1)
        `).run(hashC);

        const insights = await Srs.getCardInsights(hashC, { algorithm: 'leitner' });
        assert.equal(insights.history.length, 3, 'the ledger shows every stored row');
        assert.equal(insights.history.filter(h => h.synthetic).length, 1);
        assert.equal(insights.srs.syntheticEntries, 1);
        assert.equal(insights.srs.reviews, 2, 'a synthetic row is not a review');
        assert.equal(insights.srs.correct, 1);
        assert.equal(insights.srs.retention, 0.5, 'and must not dilute retention');
        assert.deepEqual(insights.history.map(h => h.algorithm), ['leitner', 'leitner', null],
            'rows keep insertion order, and one with neither an algorithm nor a rating is not guessed at');
    });

    it('throws for an unknown card', async () => {
        await assert.rejects(async () => await Srs.getCardInsights('no-such-card'), /not found/);
    });
});

describe('vault learned aggregate', () => {
    const ROOT2 = 'VaultLearnedTest';
    const big = Array.from({ length: 20 }, () => crypto.randomUUID());
    const lone = crypto.randomUUID();

    const rm2 = () => {
        try {
            const abs = path.join(getWorkspacePath(), ROOT2);
            if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        } catch {  }
    };

    before(async () => {
        rm2();
        await Documents.createFolder(ROOT2);
        await Documents.importFile('many.md', ROOT2, Buffer.from('# Many'), {
            globalHash: crypto.randomUUID(),
            flashcards: big.map(h => ({ globalHash: h, vanillaData: { frontText: 'q', backText: 'a' } })),
        });
        await Documents.importFile('one.md', ROOT2, Buffer.from('# One'), {
            globalHash: crypto.randomUUID(),
            flashcards: [{ globalHash: lone, vanillaData: { frontText: 'q', backText: 'a' } }],
        });
    });

    after(() => rm2());

    it('counts every card in the denominator, including ones never reviewed', async () => {
        const learned = await statisticsRows.getVaultLearned('owner');
        const total = await flashcardRows.getCount();
        assert.equal(learned.cards, total,
            'a card with no CardProgress row is unlearned, not absent');
    });

    it('scores an unreviewed card 0 rather than dropping it', async () => {
        const before = await statisticsRows.getVaultLearned('owner');
        const extraDoc = path.join(ROOT2, 'fresh.md');
        const fresh = crypto.randomUUID();
        await Documents.importFile('fresh.md', ROOT2, Buffer.from('# Fresh'), {
            globalHash: crypto.randomUUID(),
            flashcards: [{ globalHash: fresh, vanillaData: { frontText: 'q', backText: 'a' } }],
        });

        const after_ = await statisticsRows.getVaultLearned('owner');
        assert.equal(after_.cards, before.cards + 1, 'the denominator grew');
        assert.equal(after_.learnedSum, before.learnedSum,
            'and the numerator did not — an unstudied card adds nothing');
        assert.ok(after_.learnedSum / after_.cards <= before.learnedSum / before.cards,
            'so adding unstudied material can only lower completeness');
        assert.ok(extraDoc);
    });

    it('is card-weighted, so one mastered card cannot outvote twenty unstudied ones', async () => {
        const before = await statisticsRows.getVaultLearned('owner');
        await Documents.submitReview(path.join(ROOT2, 'one.md'), lone, 1, 2.5, 6, 'leitner');
        const after_ = await statisticsRows.getVaultLearned('owner');

        assert.ok(after_.learnedSum - before.learnedSum > 0.99,
            'the reviewed card contributes its full weight');
        assert.equal(after_.cards, before.cards, 'and the denominator is unchanged');

        const score = after_.learnedSum / after_.cards;
        assert.ok(score < 0.5,
            `one card among ${after_.cards} must not read as half the vault (got ${score})`);
    });

    it('refuses a missing scope rather than answering for the owner', async () => {
        await assert.rejects(() => statisticsRows.getVaultLearned(), /account scope/);
    });
});
