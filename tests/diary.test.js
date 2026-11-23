import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import git from 'isomorphic-git';
import validate from '../src/api/config/validate.js';
import Documents from '../src/api/access/modules/documents.js';
import Decks from '../src/api/access/modules/decks.js';
import Files from '../src/api/access/resources/files.js';
import db from '../src/api/access/primitives/database.js';
import * as deckRows from '../src/api/access/resources/db/decks.js';
import * as documentRows from '../src/api/access/resources/db/documents.js';
import * as statisticsRows from '../src/api/access/resources/db/statistics.js';
import diary from '../src/api/access/modules/diary.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getVaultPath, getWorkspacePath } from '../src/api/access/primitives/config.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const decks = new Decks();
const files = new Files();
const ROOT = 'StudyLogTestWs';
const DAY = '2026-06-01';
const NEXT = '2026-06-02';
const hashes = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

const diaryRoot = () => path.join(getVaultPath(), 'diary');

const cleanup = async () => {
    try {
        const abs = path.join(getWorkspacePath(), ROOT);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    } catch {  }
    try {
        if (fs.existsSync(diaryRoot())) fs.rmSync(diaryRoot(), { recursive: true, force: true });
    } catch {  }
    try {
        await db.prepare("DELETE FROM ReviewLogs WHERE date(timestamp, 'localtime') IN (?, ?)").run(DAY, NEXT);
    } catch {  }
};

const fcId = async (hash) => (await db.prepare('SELECT id FROM Flashcards WHERE global_hash = ?').get(hash)).id;

const localIso = (dayIso, hh) => {
    const [y, m, d] = dayIso.split('-').map(Number);
    return new Date(y, m - 1, d, hh, 0, 0, 0).toISOString();
};
const insertLog = async (fid, outcome, dayIso, hh) =>
    await db.prepare(
        'INSERT INTO ReviewLogs (card_hash, timestamp, outcome, ease_factor, level) VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?)'
    ).run(fid, localIso(dayIso, hh), outcome, 2.5, 0);

describe('Diary storage layer', () => {
    before(async () => {
        await cleanup();
        await sealTools.init();
        await docs.createFolder(ROOT);
        await docs.importFile('deck.md', ROOT, Buffer.from('# Deck'), {
            globalHash: crypto.randomUUID(),
            flashcards: hashes.map((h, i) => ({
                globalHash: h, level: 0, vanillaData: { frontText: `Q${i}`, backText: `A${i}` },
            })),
        });
        await insertLog(await fcId(hashes[0]), 1, DAY, '10');
        await insertLog(await fcId(hashes[1]), 1, DAY, '11');
        await insertLog(await fcId(hashes[2]), 0, DAY, '12');
        await insertLog(await fcId(hashes[2]), 0, DAY, '13');
    });

    after(async () => await cleanup());

    it('derives the day summary from ReviewLogs with the v2 schema', async () => {
        const s = await diary.generateSummary(DAY);
        assert.ok(s, 'summary written');
        assert.equal(s.schemaVersion, 2);
        assert.equal(s.date, DAY);
        assert.equal(s.totals.reviews, 4);
        assert.equal(s.totals.uniqueCards, 3);
        assert.equal(s.totals.newCards, 3);
        assert.equal(s.totals.failed, 2);
        assert.equal(s.retention.passRate, 0.5);

        assert.equal(s.retention.learningCount, 4);
        assert.equal(s.retention.learningPassRate, 0.5);
        assert.equal(s.retention.reviewCount, 0);
        assert.equal(s.retention.reviewPassRate, null);

        const doc = s.byDocument.find(d => d.path.endsWith('deck.md'));
        assert.ok(doc, 'byDocument includes the source document');
        assert.equal(doc.reviews, 4);
        assert.ok(doc.path.includes('/'), 'document path normalized to forward slashes');

        const struggled = s.struggledCards.find(c => c.globalHash === hashes[2]);
        assert.ok(struggled, 'the twice-failed card is listed as struggled');
        assert.equal(struggled.failCount, 2);
        assert.equal(struggled.front, 'Q2');

        assert.equal(s.streak.current, 1);
        assert.equal(s.streak.longest, 1);
        assert.ok(Array.isArray(s.byDeck));

        assert.ok(fs.existsSync(path.join(diaryRoot(), 'summaries', `summary-${DAY}.json`)));
    });

    it('is idempotent: regenerating a past date reproduces the same file (modulo generatedAt)', async () => {
        const a = await diary.generateSummary(DAY);
        const b = await diary.generateSummary(DAY);
        delete a.generatedAt; delete b.generatedAt;
        assert.deepEqual(a, b);
    });

    it('writes nothing for a day with no reviews', async () => {
        const s = await diary.generateSummary(NEXT);
        assert.equal(s, null);
        assert.ok(!fs.existsSync(path.join(diaryRoot(), 'summaries', `summary-${NEXT}.json`)));
    });

    it('lives outside the workspace and never appears in the graph, index, or search', async () => {
        const rel = path.relative(getWorkspacePath(), diaryRoot());
        assert.ok(rel.startsWith('..'), 'diary root is outside the workspace root');

        const walk = files.walkWorkspace();
        const walked = [...walk.folders, ...walk.documents].map(e => e.relPath);
        assert.ok(walked.every(p => !p.toLowerCase().includes('diary')), 'walkWorkspace excludes diary');

        const norm = (p) => (p || '').replace(/\\/g, '/');
        const diaryAbs = norm(diaryRoot());
        const under = (await documentRows.getAll()).filter(d => norm(d.absolute_path).startsWith(diaryAbs));
        assert.equal(under.length, 0, 'no Documents rows point under diary/');

        const results = await docs.search('summary');
        assert.ok(results.every(r => !norm(r.relative_path).startsWith(diaryAbs)));
    });

    it('saves and reads back a markdown entry, and commits it', async () => {
        const res = await diary.saveEntry(DAY, '# Reflection\nStudied hiragana.');
        assert.equal(res.created, true);
        assert.equal(diary.getEntry(DAY), '# Reflection\nStudied hiragana.');
        assert.ok(fs.existsSync(path.join(diaryRoot(), 'entries', `entry-${DAY}.md`)));
    });

    it('does not create an empty entry file for a day the user never wrote', async () => {
        const res = await diary.saveEntry(NEXT, '   ');
        assert.equal(res.created, false);
        assert.equal(diary.getEntry(NEXT), null);
        assert.ok(!fs.existsSync(path.join(diaryRoot(), 'entries', `entry-${NEXT}.md`)));
    });

    it('versions diary files in its own git repo', async () => {
        const commits = await git.log({ fs, dir: diaryRoot() });
        assert.ok(commits.length >= 2, 'summary + entry each produced a commit');
        assert.ok(commits.some(c => c.commit.message.startsWith('summary:')));
        assert.ok(commits.some(c => c.commit.message.startsWith('entry:')));
    });

    it('lists diary dates newest-first with per-kind flags', async () => {
        const list = await diary.list();
        const day = list.find(d => d.date === DAY);
        assert.ok(day && day.hasSummary && day.hasEntry);
        for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].date >= list[i].date);
    });

    it('re-derives the whole day across sessions, and commits only when it changed', async () => {
        const commits = async () => (await git.log({ fs, dir: diaryRoot() })).length;
        const first = await diary.generateSummary(DAY);
        const before = await commits();

        const again = await diary.generateSummary(DAY);
        assert.equal(await commits(), before, 'an unchanged day is not re-committed');
        assert.equal(again.totals.reviews, first.totals.reviews);

        const fid = await fcId(hashes[0]);
        await db.prepare(
            'INSERT INTO ReviewLogs (card_hash, timestamp, outcome, ease_factor, level) VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?)'
        ).run(fid, localIso(DAY, 20), 1, 2.5, 1);
        try {
            const later = await diary.generateSummary(DAY);
            assert.equal(later.totals.reviews, first.totals.reviews + 1, 'the evening session adds to the morning one');
            assert.equal(await commits(), before + 1);
            assert.equal(diary.getSummary(DAY).totals.reviews, first.totals.reviews + 1, 'and the stored file says so');
        } finally {
            await db.prepare('DELETE FROM ReviewLogs WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND timestamp = ?')
                .run(fid, localIso(DAY, 20));
            await diary.generateSummary(DAY);
        }
    });

    it('buckets a late-evening review into the LOCAL day, not the UTC one', async () => {
        const fid = await fcId(hashes[0]);
        await db.prepare(
            'INSERT INTO ReviewLogs (card_hash, timestamp, outcome, ease_factor, level) VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?)'
        ).run(fid, localIso(DAY, 23), 1, 2.5, 0);

        try {
            const totals = await statisticsRows.getDayReviewTotals(DAY, 'owner');
            assert.equal(totals.reviews, 5, 'the 23:00 review belongs to the day the user was studying');

            const utcDay = new Date(localIso(DAY, 23)).toISOString().slice(0, 10);
            if (utcDay !== DAY) {
                assert.equal((await statisticsRows.getDayReviewTotals(utcDay, 'owner')).reviews, 0,
                    'and must not leak into the adjacent UTC day');
            }
            assert.ok((await statisticsRows.getReviewActivityDays('owner')).includes(DAY));
        } finally {
            await db.prepare('DELETE FROM ReviewLogs WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND timestamp = ?')
                .run(fid, localIso(DAY, 23));
        }
    });
});


describe('Diary by-deck breakdown', () => {
    const ROOT2 = 'DiaryDeckTestWs';
    const D = '2026-06-05';
    let deckHash;
    let standaloneHash;
    let docCardHash;

    const cleanup2 = async () => {
        try {
            const abs = path.join(getWorkspacePath(), ROOT2);
            if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        } catch {  }
        try {
            await db.prepare("DELETE FROM ReviewLogs WHERE date(timestamp, 'localtime') = ?").run(D);
        } catch {  }
    };

    before(async () => {
        await cleanup2();
        await sealTools.init();
        await docs.createFolder(ROOT2);

        docCardHash = crypto.randomUUID();
        await docs.importFile('cards.md', ROOT2, Buffer.from('# Cards'), {
            globalHash: crypto.randomUUID(),
            flashcards: [{ globalHash: docCardHash, level: 0, vanillaData: { frontText: 'Qd', backText: 'Ad' } }],
        });

        standaloneHash = await decks.createStandaloneCard({
            frontText: 'Q-standalone', backText: 'A-standalone', cardType: 'basic',
        });

        deckHash = await decks.createDeck('Real Deck');
        await decks.addEntry(deckHash, { cardHash: docCardHash, documentPath: path.join(ROOT2, 'cards.md') });

        await insertLog(await fcId(standaloneHash), 1, D, 9);
        await insertLog(await fcId(docCardHash), 1, D, 9);
    });

    after(async () => await cleanup2());

    it('omits the system deck, which is a fallback bucket and not a deck the user built', async () => {
        const rows = await statisticsRows.getDayByDeck(D, 'owner');
        const systemDeck = await deckRows.getSystem();
        assert.ok(systemDeck, 'precondition: the vault has a system deck');
        assert.ok(rows.every(r => r.deck !== systemDeck.name),
            `system deck "${systemDeck.name}" must not appear as a by-deck bar`);
    });

    it('still lists real decks, and still counts the standalone review in the totals', async () => {
        const rows = await statisticsRows.getDayByDeck(D, 'owner');
        const real = rows.find(r => r.deck === 'Real Deck');
        assert.ok(real, 'a user-created deck is still reported');
        assert.equal(real.reviews, 1);

        assert.equal((await statisticsRows.getDayReviewTotals(D, 'owner')).reviews, 2);
    });
});
