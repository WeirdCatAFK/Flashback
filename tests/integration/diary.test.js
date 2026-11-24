import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import validate from '../../src/api/config/validate.js';
import * as Documents from '../../src/api/access/modules/documents.js';
import * as Decks from '../../src/api/access/modules/decks.js';
import * as Files from '../../src/api/access/resources/files.js';
import db from '../../src/api/access/primitives/database.js';
import * as deckRows from '../../src/api/access/resources/db/decks.js';
import * as documentRows from '../../src/api/access/resources/db/documents.js';
import * as statisticsRows from '../../src/api/access/resources/db/statistics.js';
import * as diaryRows from '../../src/api/access/resources/db/diary.js';
import * as Diary from '../../src/api/access/modules/diary.js';
import { sealTools, sealEmitter } from '../../src/api/seal/seal.js';
import { getVaultPath, getWorkspacePath } from '../../src/api/access/primitives/config.js';
import { testDataDir } from '../support/testData.js';

process.env.USER_DATA_PATH = testDataDir('diary');

if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const ROOT = 'StudyLogTestWs';
const DAY = '2026-06-01';
const NEXT = '2026-06-02';
const hashes = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

const diaryRoot = () => path.join(getWorkspacePath(), '_diary');
const ownerEntry = (day) => path.join(diaryRoot(), 'owner', `${day}.md`);

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
        await Documents.createFolder(ROOT);
        await Documents.importFile('deck.md', ROOT, Buffer.from('# Deck'), {
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
        const s = await Diary.generateSummary(DAY);
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

        assert.ok(await diaryRows.getSummary(DAY, 'owner'), 'a past day is cached in the index');
        assert.ok(!fs.existsSync(path.join(diaryRoot(), 'owner', 'summaries')), 'no summary file is written');
    });

    it('is idempotent: regenerating a past date reproduces the same file (modulo generatedAt)', async () => {
        const a = await Diary.generateSummary(DAY);
        const b = await Diary.generateSummary(DAY);
        delete a.generatedAt; delete b.generatedAt;
        assert.deepEqual(a, b);
    });

    it('writes nothing for a day with no reviews', async () => {
        const s = await Diary.generateSummary(NEXT);
        assert.equal(s, null);
        assert.equal(await diaryRows.getSummary(NEXT, 'owner'), null);
    });

    it('lives in _diary/, which the walk, the index, search and the documents API never reach', async () => {
        await Diary.saveEntry('2026-06-03', 'a private note');
        assert.ok(!Files.listFolder('').some((e) => e.name === '_diary'), 'the explorer listing hides _diary');
        assert.throws(() => Files.safePath(path.join('_diary', 'owner', `${DAY}.md`)), { code: 'reserved_path' });

        const walk = Files.walkWorkspace();
        const walked = [...walk.folders, ...walk.documents].map(e => e.relPath);
        assert.ok(walked.every(p => !p.toLowerCase().includes('diary')), 'walkWorkspace excludes diary');

        const norm = (p) => (p || '').replace(/\\/g, '/');
        const diaryAbs = norm(diaryRoot());
        const under = (await documentRows.getAll()).filter(d => norm(d.absolute_path).startsWith(diaryAbs));
        assert.equal(under.length, 0, 'no Documents rows point under diary/');

        const results = await Documents.search('summary');
        assert.ok(results.every(r => !norm(r.relative_path).startsWith(diaryAbs)));
    });

    it('saves and reads back a markdown entry, and commits it', async () => {
        const res = await Diary.saveEntry(DAY, '# Reflection\nStudied hiragana.');
        assert.equal(res.created, true);
        assert.equal(Diary.getEntry(DAY), '# Reflection\nStudied hiragana.');
        assert.ok(fs.existsSync(ownerEntry(DAY)));
        const sidecar = JSON.parse(fs.readFileSync(path.join(diaryRoot(), 'owner', '.flashback'), 'utf-8'));
        assert.ok(sidecar.createdBy, 'the folder sidecar names who writes in it');
    });

    it('does not create an empty entry file for a day the user never wrote', async () => {
        const res = await Diary.saveEntry(NEXT, '   ');
        assert.equal(res.created, false);
        assert.equal(Diary.getEntry(NEXT), null);
        assert.ok(!fs.existsSync(ownerEntry(NEXT)));
    });

    it('lets Seal version the entries with the other portable files', async () => {
        await sealEmitter.flushEdits();
        const touched = [];
        for (const c of await sealTools.log(50)) {
            const diff = await sealTools.commitFiles(c.oid);
            touched.push(...diff.added, ...diff.modified);
        }
        assert.ok(touched.includes(`_diary/owner/${DAY}.md`), 'a Seal commit holds the entry');
    });

    it('lists diary dates newest-first with per-kind flags', async () => {
        const list = await Diary.list();
        const day = list.find(d => d.date === DAY);
        assert.ok(day && day.hasSummary && day.hasEntry);
        for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].date >= list[i].date);
    });

    it('serves a past day from the cache until something regenerates it', async () => {
        const first = await Diary.generateSummary(DAY);

        const fid = await fcId(hashes[0]);
        await db.prepare(
            'INSERT INTO ReviewLogs (card_hash, timestamp, outcome, ease_factor, level) VALUES ((SELECT global_hash FROM Flashcards WHERE id = ?), ?, ?, ?, ?)'
        ).run(fid, localIso(DAY, 20), 1, 2.5, 1);
        try {
            assert.equal((await Diary.getSummary(DAY)).totals.reviews, first.totals.reviews, 'the cache still answers');
            const later = await Diary.generateSummary(DAY);
            assert.equal(later.totals.reviews, first.totals.reviews + 1, 'the evening session adds to the morning one');
            assert.equal((await Diary.getSummary(DAY)).totals.reviews, first.totals.reviews + 1, 'and the cache says so');
        } finally {
            await db.prepare('DELETE FROM ReviewLogs WHERE card_hash = (SELECT global_hash FROM Flashcards WHERE id = ?) AND timestamp = ?')
                .run(fid, localIso(DAY, 20));
            await Diary.generateSummary(DAY);
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
        await Documents.createFolder(ROOT2);

        docCardHash = crypto.randomUUID();
        await Documents.importFile('cards.md', ROOT2, Buffer.from('# Cards'), {
            globalHash: crypto.randomUUID(),
            flashcards: [{ globalHash: docCardHash, level: 0, vanillaData: { frontText: 'Qd', backText: 'Ad' } }],
        });

        standaloneHash = await Decks.createStandaloneCard({
            frontText: 'Q-standalone', backText: 'A-standalone', cardType: 'basic',
        });

        deckHash = await Decks.createDeck('Real Deck');
        await Decks.addEntry(deckHash, { cardHash: docCardHash, documentPath: path.join(ROOT2, 'cards.md') });

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

describe('Diary from an older build', () => {
    const legacyRoot = () => path.join(getVaultPath(), 'diary');

    before(() => {
        fs.rmSync(legacyRoot(), { recursive: true, force: true });
        fs.rmSync(`${legacyRoot()}.legacy`, { recursive: true, force: true });
        fs.mkdirSync(path.join(legacyRoot(), 'entries'), { recursive: true });
        fs.mkdirSync(path.join(legacyRoot(), 'accounts', 'acct-1', 'entries'), { recursive: true });
        fs.writeFileSync(path.join(legacyRoot(), 'entries', 'entry-2020-01-01.md'), 'owner wrote this');
        fs.writeFileSync(path.join(legacyRoot(), 'accounts', 'acct-1', 'entries', 'entry-2020-01-02.md'), 'a collaborator wrote this');
    });

    it('moves every entry into _diary/ once, and keeps the old folder as diary.legacy', async () => {
        assert.equal(await Diary.adoptLegacyFolder(), 2);
        assert.equal(Diary.getEntry('2020-01-01', 'owner'), 'owner wrote this');
        assert.equal(Diary.getEntry('2020-01-02', 'acct-1'), 'a collaborator wrote this');
        assert.ok(!fs.existsSync(legacyRoot()), 'the old folder moved aside');
        assert.ok(fs.existsSync(`${legacyRoot()}.legacy`), 'and stays for a manual rollback');
        assert.equal(await Diary.adoptLegacyFolder(), 0, 'a second run finds nothing to move');
    });
});
