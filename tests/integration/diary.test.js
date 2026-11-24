import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import AdmZip from 'adm-zip';
import validate from '../../src/api/config/validate.js';
import * as Documents from '../../src/api/access/modules/documents.js';
import * as Decks from '../../src/api/access/modules/decks.js';
import * as Doctor from '../../src/api/access/modules/doctor.js';
import db from '../../src/api/access/primitives/database.js';
import * as deckRows from '../../src/api/access/resources/db/decks.js';
import * as statisticsRows from '../../src/api/access/resources/db/statistics.js';
import * as diaryRows from '../../src/api/access/resources/db/diary.js';
import * as Diary from '../../src/api/access/modules/diary.js';
import { sealTools, sealEmitter } from '../../src/api/seal/seal.js';
import { getVaultPath, getWorkspacePath } from '../../src/api/access/primitives/config.js';
import { runWithAccount } from '../../src/api/requestContext.js';
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
const asAccount = (id, fn) => runWithAccount({ id, role: 'reader', name: id, email: `${id}@example.invalid` }, fn);

const cleanup = async () => {
    try {
        const abs = path.join(getWorkspacePath(), ROOT);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    } catch {  }
    try {
        await db.prepare('DELETE FROM progress.DiaryEntries').run();
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

    it('keeps an entry out of the workspace, and out of Seal', async () => {
        const commits = (await sealTools.log(500)).length;
        await Diary.saveEntry('2026-06-03', 'a private note');
        await sealEmitter.flushEdits();

        assert.ok(!fs.existsSync(diaryRoot()), 'no entry reaches the shared files');
        assert.equal((await sealTools.log(500)).length, commits, 'and Seal commits nothing');
        assert.equal((await Documents.search('private note')).length, 0);
    });

    it('gives each person only their own entries', async () => {
        await Diary.saveEntry(DAY, 'the owner wrote this');
        await asAccount('acct-rita', () => Diary.saveEntry(DAY, 'rita wrote this'));

        assert.equal(await Diary.getEntry(DAY), 'the owner wrote this');
        assert.equal(await asAccount('acct-rita', () => Diary.getEntry(DAY)), 'rita wrote this');
        assert.equal(await asAccount('acct-sam', () => Diary.getEntry(DAY)), null);
        assert.equal(await Diary.getEntry(DAY, 'acct-rita'), 'the owner wrote this', 'a second argument selects nobody else');
    });

    it('lists what another person studied, and nothing that they wrote', async () => {
        await asAccount('acct-rita', () => Diary.saveEntry('2026-06-04', 'rita wrote this'));
        assert.deepEqual(await Diary.listSummaries({ scope: 'acct-rita' }), [], 'a day with only an entry stays private');
        for (const day of await Diary.listSummaries({ scope: 'owner' })) {
            assert.deepEqual(Object.keys(day).sort(), ['date', 'hasSummary', 'reviews']);
        }
    });

    it('exports the writer\'s own entries as Markdown', async () => {
        const zip = new AdmZip(await asAccount('acct-rita', () => Diary.exportEntries()));
        assert.deepEqual(zip.getEntries().map((e) => e.entryName).sort(), [`${DAY}.md`, '2026-06-04.md'].sort());
        assert.equal(zip.readAsText(`${DAY}.md`), 'rita wrote this');
    });

    it('saves and reads back a markdown entry', async () => {
        assert.equal((await Diary.saveEntry('2026-06-06', 'first')).created, true);
        assert.equal((await Diary.saveEntry('2026-06-06', '# Reflection\nStudied hiragana.')).created, false);
        assert.equal(await Diary.getEntry('2026-06-06'), '# Reflection\nStudied hiragana.');
    });

    it('survives a Doctor rebuild of the index', async () => {
        await Doctor.rebuildIndex();
        assert.equal(await Diary.getEntry('2026-06-06'), '# Reflection\nStudied hiragana.');
    });

    it('does not create an empty entry file for a day the user never wrote', async () => {
        const res = await Diary.saveEntry(NEXT, '   ');
        assert.equal(res.created, false);
        assert.equal(await Diary.getEntry(NEXT), null);
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
    const keptFolders = () => fs.readdirSync(getVaultPath()).filter((n) => n.startsWith('diary.legacy'));

    before(async () => {
        await db.prepare('DELETE FROM progress.DiaryEntries').run();
        fs.rmSync(legacyRoot(), { recursive: true, force: true });
        for (const name of keptFolders()) fs.rmSync(path.join(getVaultPath(), name), { recursive: true, force: true });

        fs.mkdirSync(path.join(legacyRoot(), 'entries'), { recursive: true });
        fs.mkdirSync(path.join(legacyRoot(), 'accounts', 'acct-1', 'entries'), { recursive: true });
        fs.writeFileSync(path.join(legacyRoot(), 'entries', 'entry-2020-01-01.md'), 'owner wrote this');
        fs.writeFileSync(path.join(legacyRoot(), 'accounts', 'acct-1', 'entries', 'entry-2020-01-02.md'), 'a collaborator wrote this');

        fs.mkdirSync(path.join(diaryRoot(), 'owner'), { recursive: true });
        fs.mkdirSync(path.join(diaryRoot(), 'acct-1'), { recursive: true });
        fs.writeFileSync(path.join(diaryRoot(), 'owner', '.flashback'), '{}');
        fs.writeFileSync(path.join(diaryRoot(), 'owner', '2020-01-03.md'), 'written in the shared files');
        fs.writeFileSync(path.join(diaryRoot(), 'acct-1', '2020-01-04.md'), 'theirs, in the shared files');
        fs.writeFileSync(path.join(diaryRoot(), 'owner', '2020-01-05.md'), 'the stale copy');
        await sealEmitter.edit('_diary/owner/2020-01-03.md', ['_diary/owner/.flashback', '_diary/acct-1/2020-01-04.md']);
        await Diary.saveEntry('2020-01-05', 'the newer text');
    });

    it('moves every entry into the progress store, under its writer', async () => {
        assert.equal(await Diary.adoptFiles(), 4);
        assert.equal(await Diary.getEntry('2020-01-01'), 'owner wrote this');
        assert.equal(await Diary.getEntry('2020-01-03'), 'written in the shared files');
        assert.equal(await asAccount('acct-1', () => Diary.getEntry('2020-01-02')), 'a collaborator wrote this');
        assert.equal(await asAccount('acct-1', () => Diary.getEntry('2020-01-04')), 'theirs, in the shared files');
        assert.equal(await Diary.getEntry('2020-01-05'), 'the newer text', 'a file never replaces an entry');
    });

    it('takes the files out of the workspace and out of the Seal history, and keeps a copy', async () => {
        assert.ok(!fs.existsSync(diaryRoot()) && !fs.existsSync(legacyRoot()));
        const log = await sealTools.log(500);
        assert.ok(log.length > 1, 'the rest of the history stays');
        for (const { oid, commit } of log) {
            assert.ok(!commit.message.includes('_diary'));
            const { added, modified, deleted } = await sealTools.commitFiles(oid);
            assert.ok(![...added, ...modified, ...deleted].some((file) => file.startsWith('_diary')));
        }

        const kept = keptFolders().flatMap((n) => fs.readdirSync(path.join(getVaultPath(), n), { recursive: true }));
        for (const name of ['entry-2020-01-01.md', '2020-01-05.md']) {
            assert.ok(kept.some((f) => f.endsWith(name)), `${name} stays for a manual rollback`);
        }
    });

    it('never lets the Doctor commit a diary file that is still on disk', async () => {
        fs.mkdirSync(path.join(diaryRoot(), 'owner'), { recursive: true });
        fs.writeFileSync(path.join(diaryRoot(), 'owner', '2020-01-06.md'), 'restored by hand');
        try {
            await sealTools.commitDrift();
            const { added } = await sealTools.commitFiles((await sealTools.log(1))[0].oid);
            assert.ok(!added.some((file) => file.startsWith('_diary')));
        } finally {
            fs.rmSync(diaryRoot(), { recursive: true, force: true });
        }
    });

    it('does nothing on a second run', async () => {
        const before = keptFolders().length;
        assert.equal(await Diary.adoptFiles(), 0);
        assert.equal(keptFolders().length, before);
    });
});
