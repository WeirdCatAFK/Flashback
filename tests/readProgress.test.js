/**
 * Read progress: where each person has read to, and how far through a folder they are.
 *
 * The properties pinned here are the ones that make the feature real rather than nominal:
 *
 *   1. **Privacy.** Two people reading one document hold independent positions, and the
 *      Author's resolve to the OWNER_SCOPE sentinel rather than to their account id.
 *   2. **Reading is not editing.** Recording a position writes no sidecar and produces no Seal
 *      commit — for the owner too, which is where this departs from per-user SRS.
 *   3. **The furthest mark.** `auto` advances it and never regresses it; `manual` may move it
 *      backwards, because an explicit correction has to be obeyable.
 *   4. **Identity, not location.** Positions are keyed by globalHash, so they survive a rename
 *      and do not follow a copy (which regenerates identities).
 *   5. **Durability.** A Doctor rebuild wipes the derived database; read progress is not
 *      derived and must come through untouched.
 *   6. **Rollups.** Unread documents stay in the denominator, an unknown denominator never
 *      counts as finished, and two people get different rollups over one folder.
 *
 * Scope is normally resolved from the request context, so these tests enter one explicitly
 * with `runWithAccount` — the same thing `auth/authenticate.js` does per request.
 *
 * Run: node --test tests/readProgress.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import process from 'process';

const ROOT = path.join(process.cwd(), 'data_test_readprogress');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// Imports are hoisted above the assignment above unless they are dynamic, and every one of
// these resolves its paths from USER_DATA_PATH at import time.
const { default: validate } = await import('../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const { default: Documents } = await import('../src/api/access/orchestration/documents.js');
const { default: Doctor } = await import('../src/api/access/orchestration/doctor.js');
const { default: readProgress, FINISHED_PCT } = await import('../src/api/access/orchestration/readProgress.js');
const { default: query } = await import('../src/api/access/resources/query.js');
const { default: Files } = await import('../src/api/access/resources/files.js');
const { default: db } = await import('../src/api/access/primitives/database.js');
const accounts = await import('../src/api/access/primitives/accounts.js');
const { getVaultId, ensureManifest } = await import('../src/api/access/primitives/vault.js');
const { sealTools } = await import('../src/api/seal/seal.js');
const { getWorkspacePath } = await import('../src/api/access/primitives/config.js');
const { runWithAccount, OWNER_SCOPE } = await import('../src/api/requestContext.js');
const { ROLES } = await import('../src/shared/roles.js');

const docs = new Documents();
const doctor = new Doctor();
const files = new Files();
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
        await docs.createFolder(FOLDER);

        // Four documents, so a rollup has something to average over.
        for (const name of ['book.md', 'second.md', 'third.md', 'fourth.md']) {
            await docs.importFile(name, FOLDER, Buffer.from(`# ${name}`), {
                globalHash: crypto.randomUUID(),
            });
        }
    });

    after(async () => {
        db.close();
        accounts.closeAccounts();
        await new Promise(r => setTimeout(r, 50));
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows file locks */ }
    });

    // --- 1. Privacy --------------------------------------------------------------

    describe('two people, one document', () => {
        it('reads as null before anyone opens it', async () => {
            assert.equal(await readProgress.get(bookRel), null,
                'a missing row means never started, not "at zero"');
        });

        it('keeps each person on their own position', async () => {
            await readProgress.set(bookRel, { unit: 'page', position: { page: 40 }, total: 100 });
            await asAccount(rita, () => readProgress.set(
                bookRel, { unit: 'page', position: { page: 7 }, total: 100 },
            ));

            assert.equal((await readProgress.get(bookRel)).position.page, 40, "the author's page");
            const hers = await asAccount(rita, () => readProgress.get(bookRel));
            assert.equal(hers.position.page, 7, 'hers, in the same document');
        });

        it('files the author under the owner sentinel, not their account id', async () => {
            const owner = await accounts.getReadProgress(
                getVaultId(), OWNER_SCOPE, (await query.getDocumentByPath(bookRel)).global_hash,
            );
            assert.ok(owner, 'the author resolves to OWNER_SCOPE');
            assert.equal(JSON.parse(owner.pos).page, 40);

            const byId = await accounts.getReadProgress(
                getVaultId(), author.id, (await query.getDocumentByPath(bookRel)).global_hash,
            );
            assert.equal(byId, undefined, 'and never to their uuid, which a copied vault would orphan');
        });
    });

    // --- 2. Reading is not editing -----------------------------------------------

    describe('what a position costs the vault', () => {
        it('writes no sidecar and seals nothing — for the owner too', async () => {
            const sidecarBefore = JSON.stringify(docs.files.getMetadata(bookRel));
            const logBefore = await sealTools.log();

            await readProgress.set(bookRel, { unit: 'page', position: { page: 55 }, total: 100 });
            await asAccount(rita, () => readProgress.set(
                bookRel, { unit: 'page', position: { page: 9 }, total: 100 },
            ));

            assert.equal(JSON.stringify(docs.files.getMetadata(bookRel)), sidecarBefore,
                'the canonical file is untouched');
            assert.equal((await sealTools.log()).length, logBefore.length,
                'reading is not editing — no commit, whoever is reading');
        });
    });

    // --- 3. The furthest mark ------------------------------------------------------

    describe('the furthest mark', () => {
        it('advances when you move forward', async () => {
            const p = await readProgress.set(bookRel, { unit: 'page', position: { page: 80 }, total: 100 });
            assert.equal(p.furthest.page, 80);
            assert.equal(p.position.page, 80);
        });

        it('does not regress when you scroll back to check something', async () => {
            const p = await readProgress.set(bookRel, { unit: 'page', position: { page: 12 }, total: 100 });
            assert.equal(p.position.page, 12, 'where you are now');
            assert.equal(p.furthest.page, 80, 'but you have still read to 80');
        });

        it('lets a manual correction move it backwards', async () => {
            const p = await readProgress.set(
                bookRel, { unit: 'page', position: { page: 20 }, total: 100, mode: 'manual' },
            );
            assert.equal(p.furthest.page, 20, '"I actually only got to page 20" has to be obeyable');
        });

        it('derives a percent when the caller sends none', async () => {
            const p = await readProgress.set(
                bookRel, { unit: 'page', position: { page: 50 }, total: 100, mode: 'manual' },
            );
            assert.equal(p.percent, 0.5);
        });

        it('marks finished at the threshold, not only at exactly the end', async () => {
            const p = await readProgress.set(
                bookRel, { unit: 'page', position: { page: 97 }, total: 100, mode: 'manual' },
            );
            assert.ok(p.furthestPercent >= FINISHED_PCT);
            assert.equal(p.finished, true, 'back matter should not keep a read book at 99%');
        });

        it('refuses a unit it cannot address', async () => {
            await assert.rejects(
                () => readProgress.set(bookRel, { unit: 'furlong', position: { page: 1 } }),
                (err) => err.status === 400,
            );
        });
    });

    // --- 4. Identity, not location -------------------------------------------------

    describe('identity', () => {
        it('survives a rename, because it is keyed by globalHash', async () => {
            const renamed = path.join(FOLDER, 'renamed.md');
            await docs.rename(bookRel, 'renamed.md');

            const p = await readProgress.get(renamed);
            assert.ok(p, 'the position followed the document');
            assert.equal(p.furthest.page, 97);

            await docs.rename(renamed, 'book.md');
        });

        it('does not follow a copy, which starts unread', async () => {
            const copyRel = path.join(FOLDER, 'book-copy.md');
            await docs.copy(bookRel, copyRel, false);
            assert.equal(await readProgress.get(copyRel), null,
                'a copy regenerates identities, so it is a different document');
            await docs.delete(copyRel, false);
        });
    });

    // --- 5. Durability -------------------------------------------------------------

    describe('a Doctor rebuild', () => {
        it('leaves read progress intact, because none of it is derived', async () => {
            const before = await readProgress.get(bookRel);
            await doctor.rebuildIndex();

            const after = await readProgress.get(bookRel);
            assert.deepEqual(after.furthest, before.furthest,
                'nothing to restore, because nothing was projected');
            assert.equal(after.percent, before.percent);
        });
    });

    // --- 6. Rollups ----------------------------------------------------------------

    describe('folder rollup', () => {
        it('keeps unread documents in the denominator', async () => {
            const r = await readProgress.rollup(FOLDER);
            assert.equal(r.total, 4, 'every document in the subtree');
            assert.equal(r.finished, 1, 'book.md, at 97%');
            assert.equal(r.unread, 3, 'the three nobody has opened');
            assert.ok(r.percent > 0 && r.percent < 1,
                'unread counts as zero rather than dropping out of the average');
        });

        it('never counts a document with no denominator as finished', async () => {
            const rel = path.join(FOLDER, 'second.md');
            await readProgress.set(rel, { unit: 'chars', position: { offset: 400 } });

            const p = await readProgress.get(rel);
            assert.equal(p.percent, null, 'no total, so no percent');

            const r = await readProgress.rollup(FOLDER);
            assert.equal(r.finished, 1, 'still just book.md');
            assert.equal(r.inProgress, 1, 'second.md counts as started');
            assert.equal(r.total, 4, 'and stays in the total');
        });

        it('gives two people different rollups over one folder', async () => {
            const mine = await readProgress.rollup(FOLDER);
            const hers = await asAccount(rita, () => readProgress.rollup(FOLDER));
            assert.equal(hers.finished, 0, 'she has finished nothing');
            assert.notEqual(hers.percent, mine.percent);
            assert.equal(hers.total, mine.total, 'over the same set of documents');
        });

        it('labels a folder that is a subscription target', async () => {
            await query.upsertSubscription({
                magazineId: 'nature', issueId: '2026-09', version: 1, targetPath: FOLDER,
            });
            const r = await readProgress.folderRollup(FOLDER);
            assert.equal(r.subscription?.magazineId, 'nature',
                '"12 of 47 issues" rather than "12 of 47 documents"');

            const plain = await readProgress.folderRollup('');
            assert.equal(plain.subscription, undefined, 'an ordinary folder rolls up unlabelled');
        });
    });

    // --- 6b. Coverage ---------------------------------------------------------------

    describe('read but not carded', () => {
        it('counts everything read as a gap when there are no cards at all', async () => {
            const cov = await readProgress.coverage(bookRel);
            assert.equal(cov.readTo, 97);
            assert.equal(cov.cards, 0);
            assert.deepEqual(cov.gap, { from: 0, to: 97 },
                '"nothing carded yet" is not the same answer as "nothing left to card"');
            assert.equal(cov.gapKnown, true);
        });

        it('measures the gap from the deepest carded position', async () => {
            const rel = path.join(FOLDER, 'carded.md');
            await docs.importFile('carded.md', FOLDER, Buffer.from('# Carded'), {
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
            await readProgress.set(rel, { unit: 'page', position: { page: 120 }, total: 200 });

            const cov = await readProgress.coverage(rel);
            assert.equal(cov.readTo, 120);
            assert.equal(cov.cardedTo, 44);
            assert.deepEqual(cov.gap, { from: 44, to: 120 }, 'read to 120, last card from 44');
            assert.equal(cov.gapKnown, true);
        });

        it('says it cannot tell rather than reporting no gap, when cards have no orderable anchor', async () => {
            const rel = path.join(FOLDER, 'unanchored.md');
            await docs.importFile('unanchored.md', FOLDER, Buffer.from('# Unanchored'), {
                globalHash: crypto.randomUUID(),
                flashcards: [
                    { globalHash: crypto.randomUUID(), vanillaData: { frontText: 'Q', backText: 'A' } },
                ],
            });
            await readProgress.set(rel, { unit: 'page', position: { page: 30 }, total: 60 });

            const cov = await readProgress.coverage(rel);
            assert.equal(cov.cardedTo, null);
            assert.equal(cov.gap, null);
            assert.equal(cov.gapKnown, false, 'unknown must not read as "fully carded"');
        });
    });

    // --- 6c. The anchor the app actually writes ---------------------------------------

    describe('highlight-anchored cards', () => {
        // Every card the UI or the MCP server creates from a selection carries
        // `location: {type:'highlight', id}` and no `data` — the geometry lives on the
        // highlight. Resolving only the legacy `{type:'pdf_location', data:{...}}` form meant
        // coverage reported "cannot tell" for every document carded the way the app cards them.
        const withHighlight = async (name, highlight, cardHash = null) => {
            const rel = path.join(FOLDER, name);
            const hid = `h_${name}`;
            await docs.importFile(name, FOLDER, Buffer.from(`# ${name}`), {
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
            await readProgress.set(rel, { unit: 'page', position: { page: 120 }, total: 200 });

            const cov = await readProgress.coverage(rel);
            assert.equal(cov.cardedTo, 88, 'the position is on the highlight, not on the card');
            assert.deepEqual(cov.gap, { from: 88, to: 120 });
            assert.equal(cov.gapKnown, true);
        });

        it('reads character offsets off a text highlight', async () => {
            const rel = await withHighlight('hl-text.md', { type: 'text_offset', start: 400, end: 433 });
            await readProgress.set(rel, { unit: 'chars', position: { offset: 900 }, total: 1200 });

            const cov = await readProgress.coverage(rel);
            assert.equal(cov.cardedTo, 433, 'the END of the passage is how far it carries you');
        });

        it('reads seconds off a video highlight', async () => {
            const rel = await withHighlight('hl-video.md', { type: 'video_timestamp', start: 61, end: 75 });
            await readProgress.set(rel, { unit: 'segment', position: { seconds: 300 }, total: 600 });

            assert.equal((await readProgress.coverage(rel)).cardedTo, 61);
        });

        it('still says it cannot tell for a Markdown highlight, which carries no offsets', async () => {
            const rel = await withHighlight('hl-inline.md', {});
            await readProgress.set(rel, { unit: 'chars', position: { offset: 500 }, total: 1000 });

            const cov = await readProgress.coverage(rel);
            assert.equal(cov.cardedTo, null, 'an inline <mark> anchors by text, not by offset');
            assert.equal(cov.gapKnown, false, 'and unknown must never read as "fully carded"');
        });

        it('resolves through location.id, not through the cardHashes mirror', async () => {
            // The old resolver's second loop was gated on `highlights[].cardHashes`, an
            // optional mirror every renderer initialises to [] and no card path ever writes.
            const rel = await withHighlight('hl-mirror.md', { type: 'pdf_bbox', page: 12 });
            await readProgress.set(rel, { unit: 'page', position: { page: 30 }, total: 60 });
            const stored = files.getMetadata(rel);
            assert.deepEqual(stored.highlights[0].cardHashes ?? [], [],
                'the anchor is the card location.id; this array stays empty');
            assert.equal((await readProgress.coverage(rel)).cardedTo, 12);
        });
    });

    // --- 6d. Studying only what you have read ----------------------------------------

    describe('studyFilter', () => {
        const SF = 'StudyFilterTest';
        const rel = (name) => path.join(SF, name);
        let ahead, behind;

        before(async () => {
            await docs.createFolder(SF);

            // One document, two cards: one behind the mark, one well past it.
            behind = crypto.randomUUID();
            ahead = crypto.randomUUID();
            await docs.importFile('textbook.md', SF, Buffer.from('# Textbook'), {
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
            await readProgress.set(rel('textbook.md'), { unit: 'page', position: { page: 50 }, total: 300 });
        });

        it('holds back only the cards it can prove are ahead of the mark', async () => {
            const gate = await readProgress.studyFilter();
            assert.ok(gate.documents.includes(rel('textbook.md')), 'a document you have opened is allowed');
            assert.ok(gate.excludeCards.includes(ahead), 'page 290, read to page 50');
            assert.ok(!gate.excludeCards.includes(behind), 'page 12 is behind you');
        });

        it('leaves a document you have never opened out of the allow list entirely', async () => {
            await docs.importFile('untouched.md', SF, Buffer.from('# Untouched'), {
                globalHash: crypto.randomUUID(),
            });
            const gate = await readProgress.studyFilter();
            assert.ok(!gate.documents.includes(rel('untouched.md')),
                'holding its whole pile back is what absence from this list means');
        });

        it('holds nothing back in a finished document', async () => {
            const late = crypto.randomUUID();
            await docs.importFile('finished.md', SF, Buffer.from('# Finished'), {
                globalHash: crypto.randomUUID(),
                highlights: [{ id: 'h_end', type: 'pdf_bbox', page: 199, color: 'amber', text: 'end' }],
                flashcards: [{ globalHash: late, vanillaData: { frontText: 'Q', backText: 'A', location: { type: 'highlight', id: 'h_end' } } }],
            });
            await readProgress.set(rel('finished.md'), {
                unit: 'page', position: { page: 190 }, percent: 1, total: 200, mode: 'manual',
            });

            const gate = await readProgress.studyFilter();
            assert.ok(gate.documents.includes(rel('finished.md')));
            assert.ok(!gate.excludeCards.includes(late),
                'finished is finished — 0.95 exists so back matter does not keep a book short');
        });

        it('holds nothing back in an EPUB, whose CFIs are not orderable', async () => {
            const anywhere = crypto.randomUUID();
            await docs.importFile('epubish.md', SF, Buffer.from('# Epub'), {
                globalHash: crypto.randomUUID(),
                highlights: [{ id: 'h_cfi', type: 'pdf_bbox', page: 400, color: 'amber', text: 'x' }],
                flashcards: [{ globalHash: anywhere, vanillaData: { frontText: 'Q', backText: 'A', location: { type: 'highlight', id: 'h_cfi' } } }],
            });
            await readProgress.set(rel('epubish.md'), {
                unit: 'section', position: { cfi: 'epubcfi(/6/14!/4/2)', href: 'ch07.xhtml', section: 7 },
            });

            const gate = await readProgress.studyFilter();
            assert.ok(gate.documents.includes(rel('epubish.md')), 'you have opened it');
            assert.ok(!gate.excludeCards.includes(anywhere),
                'a section ordinal cannot be compared to a page, so nothing is provable');
        });

        it('never holds back a card it cannot locate', async () => {
            const loose = crypto.randomUUID();
            await docs.importFile('unanchored2.md', SF, Buffer.from('# Loose'), {
                globalHash: crypto.randomUUID(),
                flashcards: [{ globalHash: loose, vanillaData: { frontText: 'Q', backText: 'A' } }],
            });
            await readProgress.set(rel('unanchored2.md'), { unit: 'page', position: { page: 2 }, total: 500 });

            const gate = await readProgress.studyFilter();
            assert.ok(!gate.excludeCards.includes(loose),
                'the filter hides what it can prove you have not reached, not what it cannot find');
        });

        it('gives each person their own gate', async () => {
            const hers = await asAccount(rita, () => readProgress.studyFilter());
            assert.ok(!hers.documents.includes(rel('textbook.md')),
                'Rita has not opened it, so none of its cards are offered to her');
            assert.ok(!hers.excludeCards.includes(ahead));
        });
    });

    // --- 7. Listing ----------------------------------------------------------------

    describe('what am I in the middle of', () => {
        it('lists started documents and excludes finished ones', async () => {
            const list = await readProgress.listInProgress();
            const paths = list.map(r => r.path);
            assert.ok(paths.includes(path.join(FOLDER, 'second.md')), 'started');
            assert.ok(!paths.includes(bookRel), 'book.md is finished, so not "in progress"');
        });

        it('clears a position on request', async () => {
            const rel = path.join(FOLDER, 'second.md');
            await readProgress.clear(rel);
            assert.equal(await readProgress.get(rel), null);
        });
    });

    // --- 8. One scale per document -------------------------------------------------

    // Regression. EPUB percentages were arriving on two scales: epub.js reports nothing usable
    // until its locations index finishes building, and the server used to fill the gap with
    // `section / total` — a spine-item ratio, unweighted by text. A book 22% through its prose
    // recorded 48%, and because `auto` may only ever advance the furthest mark, that inflated
    // number then rejected every honest report behind it.
    describe('a section has no server-derivable percentage', () => {
        const epubRel = () => path.join(FOLDER, 'third.md');

        it('stores no percent for a section when the caller sends none', async () => {
            const p = await readProgress.set(epubRel(), {
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
            const p = await readProgress.set(epubRel(), {
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
            const page = await readProgress.set(path.join(FOLDER, 'fourth.md'), {
                unit: 'page', position: { page: 25 }, total: 100, mode: 'manual',
            });
            assert.equal(page.percent, 0.25, 'page 25 of 100 is a quarter of the pages');

            const chars = await readProgress.set(path.join(FOLDER, 'second.md'), {
                unit: 'chars', position: { offset: 300 }, total: 1200, mode: 'manual',
            });
            assert.equal(chars.percent, 0.25, 'offset 300 of 1200 is a quarter of the text');
        });

        it('does not let a real mark be overtaken by a spine ratio', async () => {
            const rel = epubRel();
            // Where the reader actually is: a fifth of the way through the text.
            await readProgress.set(rel, {
                unit: 'section',
                position: { cfi: 'a', href: 'ch05.xhtml', section: 11 },
                total: 21, percent: 0.2237, mode: 'manual',
            });
            // The report that used to arrive during the locations build, carrying no percent.
            const after = await readProgress.set(rel, {
                unit: 'section',
                position: { cfi: 'b', href: 'ch06.xhtml', section: 12 },
                total: 21, mode: 'auto',
            });
            assert.equal(after.furthestPercent, 0.2237,
                'the mark holds at the real figure rather than jumping to 12/21');
            assert.equal(after.position.section, 12, 'though the position still moves');
        });
    });


    // The one-time repair that clears the two mixed-scale percentages already on disk. Tested
    // as SQL against a throwaway database rather than through the real store, because the
    // repair runs at open and the store under test has already been opened.
    describe('the one-time repair of already-written percentages', () => {
        it('nulls section percentages, keeps their locators, and leaves other units alone', async () => {
            const { default: Database } = await import('better-sqlite3');
            const { REPAIRS } = await import('../src/api/access/primitives/accounts.js');
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
            const { REPAIRS } = await import('../src/api/access/primitives/accounts.js');
            const versions = REPAIRS.map(r => r.version);
            assert.deepEqual(versions, [...new Set(versions)].sort((a, b) => a - b),
                'versions are unique and ordered');
        });
    });

});
