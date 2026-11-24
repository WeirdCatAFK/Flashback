import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import process from 'process';
import { testDataDir } from '../support/testData.js';

const ROOT = testDataDir('readProgress');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const { default: validate } = await import('../../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const Documents = await import('../../src/api/access/modules/documents.js');
const Doctor = await import('../../src/api/access/modules/doctor.js');
const ReadProgress = await import('../../src/api/access/modules/readProgress.js'); const { FINISHED_PCT  } = ReadProgress;
const documentRows = await import('../../src/api/access/resources/db/documents.js');
const readProgressRows = await import('../../src/api/access/resources/db/readProgress.js');
const subscriptionRows = await import('../../src/api/access/resources/db/subscriptions.js');
const Files = await import('../../src/api/access/resources/files.js');
const { default: db } = await import('../../src/api/access/primitives/database.js');
const accounts = await import('../../src/api/access/primitives/accounts.js');
const { ensureManifest } = await import('../../src/api/access/primitives/vault.js');
const { sealTools } = await import('../../src/api/seal/seal.js');
const { getWorkspacePath } = await import('../../src/api/access/primitives/config.js');
const { runWithAccount, OWNER_SCOPE } = await import('../../src/api/requestContext.js');
const { ROLES } = await import('../../src/shared/roles.js');

const FOLDER = 'ReadProgressTest';
const bookRel = path.join(FOLDER, 'book.md');

const asAccount = (account, fn) => runWithAccount(account, fn);

describe('Read progress', () => {
    let author, rita;

    before(async () => {
        ensureManifest();
        await sealTools.init();

        author = await accounts.ensureLocalAuthor();
        rita = await accounts.createAccount({
            name: 'Rita', email: `rita+${Date.now()}@example.com`, role: ROLES.READER,
        });

        const abs = path.join(getWorkspacePath(), FOLDER);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        await Documents.createFolder(FOLDER);

        for (const name of ['book.md', 'second.md', 'third.md', 'fourth.md']) {
            await Documents.importFile(name, FOLDER, Buffer.from(`# ${name}`), {
                globalHash: crypto.randomUUID(),
            });
        }
    });

    after(async () => {
        db.close();
        accounts.closeAccounts();
        await new Promise(r => setTimeout(r, 50));
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {  }
    });


    describe('two people, one document', () => {
        it('reads as null before anyone opens it', async () => {
            assert.equal(await ReadProgress.get(bookRel), null,
                'a missing row means never started, not "at zero"');
        });

        it('keeps each person on their own position', async () => {
            await ReadProgress.set(bookRel, { unit: 'page', position: { page: 40 }, total: 100 });
            await asAccount(rita, () => ReadProgress.set(
                bookRel, { unit: 'page', position: { page: 7 }, total: 100 },
            ));

            assert.equal((await ReadProgress.get(bookRel)).position.page, 40, "the author's page");
            const hers = await asAccount(rita, () => ReadProgress.get(bookRel));
            assert.equal(hers.position.page, 7, 'hers, in the same document');
        });

        it('files the author under the owner sentinel, not their account id', async () => {
            const docHash = (await documentRows.getByPath(bookRel)).global_hash;

            const owner = await readProgressRows.get(OWNER_SCOPE, docHash);
            assert.ok(owner, 'the author resolves to OWNER_SCOPE');
            assert.equal(JSON.parse(owner.pos).page, 40);

            const byId = await readProgressRows.get(author.id, docHash);
            assert.equal(byId, null, 'and never to their uuid, which a copied vault would orphan');
        });
    });


    describe('what a position costs the vault', () => {
        it('writes no sidecar and seals nothing — for the owner too', async () => {
            const sidecarBefore = JSON.stringify(Files.getMetadata(bookRel));
            const logBefore = await sealTools.log();

            await ReadProgress.set(bookRel, { unit: 'page', position: { page: 55 }, total: 100 });
            await asAccount(rita, () => ReadProgress.set(
                bookRel, { unit: 'page', position: { page: 9 }, total: 100 },
            ));

            assert.equal(JSON.stringify(Files.getMetadata(bookRel)), sidecarBefore,
                'the portable file is untouched');
            assert.equal((await sealTools.log()).length, logBefore.length,
                'reading is not editing — no commit, whoever is reading');
        });
    });


    describe('the furthest mark', () => {
        it('advances when you move forward', async () => {
            const p = await ReadProgress.set(bookRel, { unit: 'page', position: { page: 80 }, total: 100 });
            assert.equal(p.furthest.page, 80);
            assert.equal(p.position.page, 80);
        });

        it('does not regress when you scroll back to check something', async () => {
            const p = await ReadProgress.set(bookRel, { unit: 'page', position: { page: 12 }, total: 100 });
            assert.equal(p.position.page, 12, 'where you are now');
            assert.equal(p.furthest.page, 80, 'but you have still read to 80');
        });

        it('lets a manual correction move it backwards', async () => {
            const p = await ReadProgress.set(
                bookRel, { unit: 'page', position: { page: 20 }, total: 100, mode: 'manual' },
            );
            assert.equal(p.furthest.page, 20, '"I actually only got to page 20" has to be obeyable');
        });

        it('derives a percent when the caller sends none', async () => {
            const p = await ReadProgress.set(
                bookRel, { unit: 'page', position: { page: 50 }, total: 100, mode: 'manual' },
            );
            assert.equal(p.percent, 0.5);
        });

        it('marks finished at the threshold, not only at exactly the end', async () => {
            const p = await ReadProgress.set(
                bookRel, { unit: 'page', position: { page: 97 }, total: 100, mode: 'manual' },
            );
            assert.ok(p.furthestPercent >= FINISHED_PCT);
            assert.equal(p.finished, true, 'back matter should not keep a read book at 99%');
        });

        it('refuses a unit it cannot address', async () => {
            await assert.rejects(
                () => ReadProgress.set(bookRel, { unit: 'furlong', position: { page: 1 } }),
                (err) => err.status === 400,
            );
        });
    });


    describe('identity', () => {
        it('survives a rename, because it is keyed by globalHash', async () => {
            const renamed = path.join(FOLDER, 'renamed.md');
            await Documents.rename(bookRel, 'renamed.md');

            const p = await ReadProgress.get(renamed);
            assert.ok(p, 'the position followed the document');
            assert.equal(p.furthest.page, 97);

            await Documents.rename(renamed, 'book.md');
        });

        it('does not follow a copy, which starts unread', async () => {
            const copyRel = path.join(FOLDER, 'book-copy.md');
            await Documents.copy(bookRel, copyRel, false);
            assert.equal(await ReadProgress.get(copyRel), null,
                'a copy regenerates identities, so it is a different document');
            await Documents.remove(copyRel, false);
        });
    });


    describe('a Doctor rebuild', () => {
        it('leaves read progress intact, because none of it is derived', async () => {
            const before = await ReadProgress.get(bookRel);
            await Doctor.rebuildIndex();

            const after = await ReadProgress.get(bookRel);
            assert.deepEqual(after.furthest, before.furthest,
                'nothing to restore, because nothing was projected');
            assert.equal(after.percent, before.percent);
        });
    });


    describe('folder rollup', () => {
        it('keeps unread documents in the denominator', async () => {
            const r = await ReadProgress.rollup(FOLDER);
            assert.equal(r.total, 4, 'every document in the subtree');
            assert.equal(r.finished, 1, 'book.md, at 97%');
            assert.equal(r.unread, 3, 'the three nobody has opened');
            assert.ok(r.percent > 0 && r.percent < 1,
                'unread counts as zero rather than dropping out of the average');
        });

        it('never counts a document with no denominator as finished', async () => {
            const rel = path.join(FOLDER, 'second.md');
            await ReadProgress.set(rel, { unit: 'chars', position: { offset: 400 } });

            const p = await ReadProgress.get(rel);
            assert.equal(p.percent, null, 'no total, so no percent');

            const r = await ReadProgress.rollup(FOLDER);
            assert.equal(r.finished, 1, 'still just book.md');
            assert.equal(r.inProgress, 1, 'second.md counts as started');
            assert.equal(r.total, 4, 'and stays in the total');
        });

        it('gives two people different rollups over one folder', async () => {
            const mine = await ReadProgress.rollup(FOLDER);
            const hers = await asAccount(rita, () => ReadProgress.rollup(FOLDER));
            assert.equal(hers.finished, 0, 'she has finished nothing');
            assert.notEqual(hers.percent, mine.percent);
            assert.equal(hers.total, mine.total, 'over the same set of documents');
        });

        it('labels a folder that is a subscription target', async () => {
            await subscriptionRows.upsert({
                magazineId: 'nature', issueId: '2026-09', version: 1, targetPath: FOLDER,
            });
            const r = await ReadProgress.folderRollup(FOLDER);
            assert.equal(r.subscription?.magazineId, 'nature',
                '"12 of 47 issues" rather than "12 of 47 documents"');

            const plain = await ReadProgress.folderRollup('');
            assert.equal(plain.subscription, undefined, 'an ordinary folder rolls up unlabelled');
        });
    });


    describe('read but not carded', () => {
        it('counts everything read as a gap when there are no cards at all', async () => {
            const cov = await ReadProgress.coverage(bookRel);
            assert.equal(cov.readTo, 97);
            assert.equal(cov.cards, 0);
            assert.deepEqual(cov.gap, { from: 0, to: 97 },
                '"nothing carded yet" is not the same answer as "nothing left to card"');
            assert.equal(cov.gapKnown, true);
        });

        it('measures the gap from the deepest carded position', async () => {
            const rel = path.join(FOLDER, 'carded.md');
            await Documents.importFile('carded.md', FOLDER, Buffer.from('# Carded'), {
                globalHash: crypto.randomUUID(),
                flashcards: [
                    {
                        globalHash: crypto.randomUUID(),
                        vanillaData: {
                            frontText: 'Q', backText: 'A',
                            location: { type: 'pdf_location', data: { page: 44 } },
                        },
                    },
                ],
            });
            await ReadProgress.set(rel, { unit: 'page', position: { page: 120 }, total: 200 });

            const cov = await ReadProgress.coverage(rel);
            assert.equal(cov.readTo, 120);
            assert.equal(cov.cardedTo, 44);
            assert.deepEqual(cov.gap, { from: 44, to: 120 }, 'read to 120, last card from 44');
            assert.equal(cov.gapKnown, true);
        });

        it('says it cannot tell rather than reporting no gap, when cards have no orderable anchor', async () => {
            const rel = path.join(FOLDER, 'unanchored.md');
            await Documents.importFile('unanchored.md', FOLDER, Buffer.from('# Unanchored'), {
                globalHash: crypto.randomUUID(),
                flashcards: [
                    { globalHash: crypto.randomUUID(), vanillaData: { frontText: 'Q', backText: 'A' } },
                ],
            });
            await ReadProgress.set(rel, { unit: 'page', position: { page: 30 }, total: 60 });

            const cov = await ReadProgress.coverage(rel);
            assert.equal(cov.cardedTo, null);
            assert.equal(cov.gap, null);
            assert.equal(cov.gapKnown, false, 'unknown must not read as "fully carded"');
        });
    });


    describe('highlight-anchored cards', () => {
        const withHighlight = async (name, highlight, cardHash = null) => {
            const rel = path.join(FOLDER, name);
            const hid = `h_${name}`;
            await Documents.importFile(name, FOLDER, Buffer.from(`# ${name}`), {
                globalHash: crypto.randomUUID(),
                highlights: [{ id: hid, color: 'amber', text: 'passage', ...highlight }],
                flashcards: [{
                    globalHash: cardHash ?? crypto.randomUUID(),
                    vanillaData: {
                        frontText: 'Q', backText: 'A',
                        location: { type: 'highlight', id: hid },
                    },
                }],
            });
            return rel;
        };

        it('locates a card through the highlight it is anchored to', async () => {
            const rel = await withHighlight('hl-pdf.md', { type: 'pdf_bbox', page: 88 });
            await ReadProgress.set(rel, { unit: 'page', position: { page: 120 }, total: 200 });

            const cov = await ReadProgress.coverage(rel);
            assert.equal(cov.cardedTo, 88, 'the position is on the highlight, not on the card');
            assert.deepEqual(cov.gap, { from: 88, to: 120 });
            assert.equal(cov.gapKnown, true);
        });

        it('reads character offsets off a text highlight', async () => {
            const rel = await withHighlight('hl-text.md', { type: 'text_offset', start: 400, end: 433 });
            await ReadProgress.set(rel, { unit: 'chars', position: { offset: 900 }, total: 1200 });

            const cov = await ReadProgress.coverage(rel);
            assert.equal(cov.cardedTo, 433, 'the END of the passage is how far it carries you');
        });

        it('reads seconds off a video highlight', async () => {
            const rel = await withHighlight('hl-video.md', { type: 'video_timestamp', start: 61, end: 75 });
            await ReadProgress.set(rel, { unit: 'segment', position: { seconds: 300 }, total: 600 });

            assert.equal((await ReadProgress.coverage(rel)).cardedTo, 61);
        });

        it('still says it cannot tell for a Markdown highlight, which carries no offsets', async () => {
            const rel = await withHighlight('hl-inline.md', {});
            await ReadProgress.set(rel, { unit: 'chars', position: { offset: 500 }, total: 1000 });

            const cov = await ReadProgress.coverage(rel);
            assert.equal(cov.cardedTo, null, 'an inline <mark> anchors by text, not by offset');
            assert.equal(cov.gapKnown, false, 'and unknown must never read as "fully carded"');
        });

        it('resolves through location.id, not through the cardHashes mirror', async () => {
            const rel = await withHighlight('hl-mirror.md', { type: 'pdf_bbox', page: 12 });
            await ReadProgress.set(rel, { unit: 'page', position: { page: 30 }, total: 60 });
            const stored = Files.getMetadata(rel);
            assert.deepEqual(stored.highlights[0].cardHashes ?? [], [],
                'the anchor is the card location.id; this array stays empty');
            assert.equal((await ReadProgress.coverage(rel)).cardedTo, 12);
        });
    });


    describe('studyFilter', () => {
        const SF = 'StudyFilterTest';
        const rel = (name) => path.join(SF, name);
        let ahead, behind;

        before(async () => {
            await Documents.createFolder(SF);

            behind = crypto.randomUUID();
            ahead = crypto.randomUUID();
            await Documents.importFile('textbook.md', SF, Buffer.from('# Textbook'), {
                globalHash: crypto.randomUUID(),
                highlights: [
                    { id: 'h_early', type: 'pdf_bbox', page: 12, color: 'amber', text: 'early' },
                    { id: 'h_late', type: 'pdf_bbox', page: 290, color: 'amber', text: 'late' },
                ],
                flashcards: [
                    { globalHash: behind, vanillaData: { frontText: 'early', backText: 'A', location: { type: 'highlight', id: 'h_early' } } },
                    { globalHash: ahead, vanillaData: { frontText: 'late', backText: 'A', location: { type: 'highlight', id: 'h_late' } } },
                ],
            });
            await ReadProgress.set(rel('textbook.md'), { unit: 'page', position: { page: 50 }, total: 300 });
        });

        it('holds back only the cards it can prove are ahead of the mark', async () => {
            const gate = await ReadProgress.studyFilter();
            assert.ok(gate.documents.includes(rel('textbook.md')), 'a document you have opened is allowed');
            assert.ok(gate.excludeCards.includes(ahead), 'page 290, read to page 50');
            assert.ok(!gate.excludeCards.includes(behind), 'page 12 is behind you');
        });

        it('leaves a document you have never opened out of the allow list entirely', async () => {
            await Documents.importFile('untouched.md', SF, Buffer.from('# Untouched'), {
                globalHash: crypto.randomUUID(),
            });
            const gate = await ReadProgress.studyFilter();
            assert.ok(!gate.documents.includes(rel('untouched.md')),
                'holding its whole pile back is what absence from this list means');
        });

        it('holds nothing back in a finished document', async () => {
            const late = crypto.randomUUID();
            await Documents.importFile('finished.md', SF, Buffer.from('# Finished'), {
                globalHash: crypto.randomUUID(),
                highlights: [{ id: 'h_end', type: 'pdf_bbox', page: 199, color: 'amber', text: 'end' }],
                flashcards: [{ globalHash: late, vanillaData: { frontText: 'Q', backText: 'A', location: { type: 'highlight', id: 'h_end' } } }],
            });
            await ReadProgress.set(rel('finished.md'), {
                unit: 'page', position: { page: 190 }, percent: 1, total: 200, mode: 'manual',
            });

            const gate = await ReadProgress.studyFilter();
            assert.ok(gate.documents.includes(rel('finished.md')));
            assert.ok(!gate.excludeCards.includes(late),
                'finished is finished — 0.95 exists so back matter does not keep a book short');
        });

        it('holds nothing back in an EPUB, whose CFIs are not orderable', async () => {
            const anywhere = crypto.randomUUID();
            await Documents.importFile('epubish.md', SF, Buffer.from('# Epub'), {
                globalHash: crypto.randomUUID(),
                highlights: [{ id: 'h_cfi', type: 'pdf_bbox', page: 400, color: 'amber', text: 'x' }],
                flashcards: [{ globalHash: anywhere, vanillaData: { frontText: 'Q', backText: 'A', location: { type: 'highlight', id: 'h_cfi' } } }],
            });
            await ReadProgress.set(rel('epubish.md'), {
                unit: 'section', position: { cfi: 'epubcfi(/6/14!/4/2)', href: 'ch07.xhtml', section: 7 },
            });

            const gate = await ReadProgress.studyFilter();
            assert.ok(gate.documents.includes(rel('epubish.md')), 'you have opened it');
            assert.ok(!gate.excludeCards.includes(anywhere),
                'a section ordinal cannot be compared to a page, so nothing is provable');
        });

        it('never holds back a card it cannot locate', async () => {
            const loose = crypto.randomUUID();
            await Documents.importFile('unanchored2.md', SF, Buffer.from('# Loose'), {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: loose, vanillaData: { frontText: 'Q', backText: 'A' } }],
            });
            await ReadProgress.set(rel('unanchored2.md'), { unit: 'page', position: { page: 2 }, total: 500 });

            const gate = await ReadProgress.studyFilter();
            assert.ok(!gate.excludeCards.includes(loose),
                'the filter hides what it can prove you have not reached, not what it cannot find');
        });

        it('gives each person their own gate', async () => {
            const hers = await asAccount(rita, () => ReadProgress.studyFilter());
            assert.ok(!hers.documents.includes(rel('textbook.md')),
                'Rita has not opened it, so none of its cards are offered to her');
            assert.ok(!hers.excludeCards.includes(ahead));
        });
    });


    describe('what am I in the middle of', () => {
        it('lists started documents and excludes finished ones', async () => {
            const list = await ReadProgress.listInProgress();
            const paths = list.map(r => r.path);
            assert.ok(paths.includes(path.join(FOLDER, 'second.md')), 'started');
            assert.ok(!paths.includes(bookRel), 'book.md is finished, so not "in progress"');
        });

        it('clears a position on request', async () => {
            const rel = path.join(FOLDER, 'second.md');
            await ReadProgress.clear(rel);
            assert.equal(await ReadProgress.get(rel), null);
        });
    });


    describe('a section has no server-derivable percentage', () => {
        const epubRel = () => path.join(FOLDER, 'third.md');

        it('stores no percent for a section when the caller sends none', async () => {
            const p = await ReadProgress.set(epubRel(), {
                unit: 'section',
                position: { cfi: 'epubcfi(/6/24!/4/2)', href: 'ch04.xhtml', section: 10 },
                total: 21,
                mode: 'manual',
            });
            assert.equal(p.percent, null,
                'a spine index over a spine count is not how far through the text you are');
            assert.equal(p.furthestPercent, null);
            assert.equal(p.position.section, 10, 'the position itself is still recorded');
            assert.equal(p.total, 21, 'and so is the length, for whoever can use it');
        });

        it('keeps the percent the caller does send', async () => {
            const p = await ReadProgress.set(epubRel(), {
                unit: 'section',
                position: { cfi: 'epubcfi(/6/26!/4/2)', href: 'ch05.xhtml', section: 11 },
                total: 21,
                percent: 0.2237,
                mode: 'manual',
            });
            assert.equal(p.percent, 0.2237, 'stored verbatim, not re-derived');
            assert.equal(p.furthestPercent, 0.2237);
        });

        it('still derives for the units where the locator IS the scale', async () => {
            const page = await ReadProgress.set(path.join(FOLDER, 'fourth.md'), {
                unit: 'page', position: { page: 25 }, total: 100, mode: 'manual',
            });
            assert.equal(page.percent, 0.25, 'page 25 of 100 is a quarter of the pages');

            const chars = await ReadProgress.set(path.join(FOLDER, 'second.md'), {
                unit: 'chars', position: { offset: 300 }, total: 1200, mode: 'manual',
            });
            assert.equal(chars.percent, 0.25, 'offset 300 of 1200 is a quarter of the text');
        });

        it('does not let a real mark be overtaken by a spine ratio', async () => {
            const rel = epubRel();
            await ReadProgress.set(rel, {
                unit: 'section',
                position: { cfi: 'a', href: 'ch05.xhtml', section: 11 },
                total: 21, percent: 0.2237, mode: 'manual',
            });
            const after = await ReadProgress.set(rel, {
                unit: 'section',
                position: { cfi: 'b', href: 'ch06.xhtml', section: 12 },
                total: 21, mode: 'auto',
            });
            assert.equal(after.furthestPercent, 0.2237,
                'the mark holds at the real figure rather than jumping to 12/21');
            assert.equal(after.position.section, 12, 'though the position still moves');
        });
    });


    describe('the one-time repair of already-written percentages', () => {
        it('nulls section percentages, keeps their locators, and leaves other units alone', async () => {
            const { default: Database } = await import('better-sqlite3');
            const { REPAIRS } = await import('../../src/api/access/primitives/accounts.js');
            const repair = REPAIRS.find(r => r.version === 1);
            assert.ok(repair, 'repair 1 exists and is versioned');

            const raw = new Database(':memory:');
            raw.exec(`CREATE TABLE ReadProgress (
                vault_id TEXT, scope TEXT, doc_hash TEXT, unit TEXT, total REAL,
                pos TEXT, pos_pct REAL, far TEXT, far_pct REAL, body_etag TEXT, updated_at TEXT)`);
            const ins = raw.prepare(`INSERT INTO ReadProgress
                (vault_id, scope, doc_hash, unit, total, pos, pos_pct, far, far_pct, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`);
            ins.run('v', 'owner', 'book', 'section', 21,
                '{"cfi":"epubcfi(/6/24)","section":11}', 0.2153,
                '{"cfi":"epubcfi(/6/22)","section":10}', 0.47619047619047616, 'then');
            ins.run('v', 'owner', 'paper', 'page', 100, '{"page":25}', 0.25, '{"page":80}', 0.8, 'then');

            raw.exec(repair.sql);

            const book = raw.prepare("SELECT * FROM ReadProgress WHERE doc_hash = 'book'").get();
            assert.equal(book.pos_pct, null, 'the mixed-scale percentages go');
            assert.equal(book.far_pct, null);
            assert.equal(book.pos, '{"cfi":"epubcfi(/6/24)","section":11}',
                'the locator does not — the book still resumes exactly where it was');
            assert.equal(book.far, '{"cfi":"epubcfi(/6/22)","section":10}');
            assert.equal(book.total, 21);
            assert.equal(book.updated_at, 'then', 'and the row is not touched otherwise');

            const paper = raw.prepare("SELECT * FROM ReadProgress WHERE doc_hash = 'paper'").get();
            assert.equal(paper.pos_pct, 0.25, 'a PDF was never on the wrong scale');
            assert.equal(paper.far_pct, 0.8);

            raw.close();
        });

        it('is recorded, so it runs once rather than on every open', async () => {
            const { REPAIRS } = await import('../../src/api/access/primitives/accounts.js');
            const versions = REPAIRS.map(r => r.version);
            assert.deepEqual(versions, [...new Set(versions)].sort((a, b) => a - b),
                'versions are unique and ordered');
        });
    });

});
