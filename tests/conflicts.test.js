/**
 * Concurrent writes to one vault: nobody's work disappears without being told.
 *
 * Three mechanisms, tested for the properties they exist to provide rather than for their
 * implementation:
 *
 *   1. **The lock** (`access/resources/pathLock.js`). A canonical write touches the filesystem
 *      before it opens its database transaction, so the database's own exclusive lock covers
 *      only half of it. Writes to one document serialize; writes to different documents do
 *      not; a move takes the whole tree, because the paths it invalidates are not knowable
 *      from the move alone.
 *   2. **The etag** (`Files.etag`). A whole-object write carries the version its author read,
 *      and is refused if the document has moved on. Omitting the version keeps the old
 *      behaviour, which is what every caller written before this does.
 *   3. **Patches merge.** A card or highlight patch names its target, so two people editing
 *      different cards of one document both succeed. Only the same entity conflicts.
 *
 * And one property that is about history rather than safety: grading cards still produces one
 * commit per session, while editing content produces one per edit, immediately.
 *
 * Run: node --test tests/conflicts.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import process from 'process';

const ROOT = path.join(process.cwd(), 'data_test_conflicts');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const { default: validate } = await import('../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const { default: Documents } = await import('../src/api/access/orchestration/documents.js');
const { default: highlightsService } = await import('../src/api/access/orchestration/highlights.js');
const { default: query } = await import('../src/api/access/resources/query.js');
const { default: db } = await import('../src/api/access/primitives/database.js');
const { PathLock, isIdle } = await import('../src/api/access/resources/pathLock.js');
const { sealTools, sealEmitter } = await import('../src/api/seal/seal.js');
const { getWorkspacePath } = await import('../src/api/access/primitives/config.js');
const { ensureManifest } = await import('../src/api/access/primitives/vault.js');

const docs = new Documents();
const FOLDER = 'Conflicts';
const docRel = path.join(FOLDER, 'shared.md');

const tick = (ms = 1) => new Promise(r => setTimeout(r, ms));
// log() pages at 20 by default; these tests count commits, so they ask for a depth no run reaches.
const LOG_DEPTH = 500;
const commitCount = async () => (await sealTools.log(LOG_DEPTH)).length;
const sidecar = (rel = docRel) => docs.files.getMetadata(rel) ?? {};
const cardIn = (hash, rel = docRel) => (sidecar(rel).flashcards ?? []).find(c => c.globalHash === hash);

describe('Concurrent writes', () => {
    let cardA, cardB;

    before(async () => {
        ensureManifest();
        await sealTools.init();

        const abs = path.join(getWorkspacePath(), FOLDER);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        await docs.createFolder(FOLDER);

        cardA = crypto.randomUUID();
        cardB = crypto.randomUUID();
        await docs.importFile('shared.md', FOLDER, Buffer.from('# Shared\n\noriginal body\n'), {
            globalHash: crypto.randomUUID(),
            flashcards: [
                { globalHash: cardA, level: 0, vanillaData: { frontText: 'Qa', backText: 'Aa' } },
                { globalHash: cardB, level: 0, vanillaData: { frontText: 'Qb', backText: 'Ab' } },
            ],
        });
    });

    after(async () => {
        await sealEmitter.quiesce();
        db.close();
        await tick(50);
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* windows file locks */ }
    });

    // --- 1. The lock itself, with no filesystem in the way -------------------------

    describe('the lock', () => {
        it('serializes writes to one document and lets different documents run at once', async () => {
            const lock = new PathLock();

            let inOne = 0, maxOne = 0;
            await Promise.all([1, 2, 3].map(() => lock.withDocument('a/b.md', async () => {
                inOne++; maxOne = Math.max(maxOne, inOne);
                await tick(5);
                inOne--;
            })));
            assert.equal(maxOne, 1, 'two writes to one document must never overlap');

            let inMany = 0, maxMany = 0;
            await Promise.all(['x.md', 'y.md', 'z.md'].map(p => lock.withDocument(p, async () => {
                inMany++; maxMany = Math.max(maxMany, inMany);
                await tick(5);
                inMany--;
            })));
            assert.equal(maxMany, 3, 'different documents must not be serialized against each other');
        });

        it('gives a structural operation the whole tree, and does not starve it', async () => {
            const lock = new PathLock();
            const order = [];

            const running = lock.withDocument('x.md', async () => { await tick(20); order.push('edit'); });
            await tick(1);
            const move = lock.withStructure(async () => { order.push('move'); });
            await tick(1);
            // Queued AFTER the move, so it must not overtake it — otherwise a steady stream
            // of edits could postpone a move forever.
            const later = lock.withDocument('y.md', async () => { order.push('later-edit'); });

            await Promise.all([running, move, later]);
            assert.deepEqual(order, ['edit', 'move', 'later-edit']);
        });

        it('releases when the body throws, and leaves nothing behind', async () => {
            const lock = new PathLock();
            await assert.rejects(() => lock.withDocument('x.md', async () => { throw new Error('boom'); }));
            await assert.rejects(() => lock.withStructure(async () => { throw new Error('boom'); }));
            await lock.withDocument('x.md', async () => {});
            assert.ok(lock.isIdle(), 'a thrown body must not leave the lock held');
            assert.equal(lock._perPath.size, 0, 'the per-path chain must not grow without bound');
        });
    });

    // --- 2. Whole-object writes carry a version ------------------------------------

    describe('a write that lost the race', () => {
        it('is refused, and changes nothing', async () => {
            const stale = docs.files.etag(docRel);

            await docs.updateFile(docRel, '# Shared\n\nfirst writer\n', sidecar(), { ifMatch: stale });
            const body = () => fs.readFileSync(docs.files.safePath(docRel), 'utf-8');
            assert.match(body(), /first writer/);

            await assert.rejects(
                () => docs.updateFile(docRel, '# Shared\n\nsecond writer\n', sidecar(), { ifMatch: stale }),
                (err) => {
                    assert.equal(err.status, 409);
                    assert.equal(err.code, 'stale');
                    assert.equal(err.etag, docs.files.etag(docRel), 'the refusal carries the version the caller needs');
                    return true;
                },
            );
            assert.match(body(), /first writer/, 'the losing write must not have landed');
        });

        it('succeeds once the caller re-reads', async () => {
            const fresh = docs.files.etag(docRel);
            const { etag } = await docs.updateFile(docRel, '# Shared\n\nsecond writer\n', sidecar(), { ifMatch: fresh });
            assert.match(fs.readFileSync(docs.files.safePath(docRel), 'utf-8'), /second writer/);
            assert.equal(etag, docs.files.etag(docRel), 'the write reports the version it produced');
        });

        it('is not checked at all when the caller sends no version', async () => {
            // The MCP server, the test suite and every script predate this and send nothing.
            await docs.updateFile(docRel, '# Shared\n\nunversioned writer\n', sidecar());
            assert.match(fs.readFileSync(docs.files.safePath(docRel), 'utf-8'), /unversioned writer/);
        });

        it('does not fail an editor because somebody added a card', async () => {
            // The half that matters is the one being replaced. An editor owns the body and
            // merges the sidecar from a fresh read, so a card added through the Inspector
            // while it was open must not turn its save into a conflict — that would make a
            // shared document unusable while changing nothing about safety.
            const loaded = docs.files.etag(docRel);
            await docs.updateFlashcard(docRel, cardB, { frontText: 'added-by-someone-else' });
            assert.notEqual(docs.files.etag(docRel), loaded, 'the sidecar half moved');

            await docs.updateFile(docRel, '# Shared\n\nthe editor saves anyway\n', sidecar(), { ifMatch: loaded });
            assert.match(fs.readFileSync(docs.files.safePath(docRel), 'utf-8'), /the editor saves anyway/);
            assert.equal(cardIn(cardB).vanillaData.frontText, 'added-by-someone-else',
                'and the change it merged is still there');
        });

        it('does fail when the body itself moved on', async () => {
            const loaded = docs.files.etag(docRel);
            await docs.updateFile(docRel, '# Shared\n\nsomeone else typed here\n', sidecar());
            await assert.rejects(
                () => docs.updateFile(docRel, '# Shared\n\nmy stale draft\n', sidecar(), { ifMatch: loaded }),
                (err) => err.status === 409 && err.code === 'stale',
            );
        });

        it('tracks the body as well as the sidecar', async () => {
            const before = docs.files.etag(docRel);
            fs.writeFileSync(docs.files.safePath(docRel), '# Shared\n\nchanged outside the app\n');
            assert.notEqual(docs.files.etag(docRel), before,
                'an edit made outside the app must still invalidate a client\'s version');
        });
    });

    // --- 3. Patches merge --------------------------------------------------------

    describe('two people patching one document', () => {
        it('both land when they touch different cards', async () => {
            await Promise.all([
                docs.updateFlashcard(docRel, cardA, { frontText: 'Qa-alice' }),
                docs.updateFlashcard(docRel, cardB, { frontText: 'Qb-bob' }),
            ]);

            assert.equal(cardIn(cardA).vanillaData.frontText, 'Qa-alice');
            assert.equal(cardIn(cardB).vanillaData.frontText, 'Qb-bob',
                'a patch to another card must not be reverted by its neighbour');
        });

        it('conflict only when they touch the same card', async () => {
            const stale = docs.cardEtag(docRel, cardA);
            await docs.updateFlashcard(docRel, cardA, { frontText: 'Qa-first' }, { ifMatch: stale });

            await assert.rejects(
                () => docs.updateFlashcard(docRel, cardA, { frontText: 'Qa-second' }, { ifMatch: stale }),
                (err) => {
                    assert.equal(err.status, 409);
                    assert.equal(err.code, 'stale');
                    return true;
                },
            );
            assert.equal(cardIn(cardA).vanillaData.frontText, 'Qa-first');

            // A patch to the OTHER card is unaffected by any of that.
            await docs.updateFlashcard(docRel, cardB, { frontText: 'Qb-later' });
            assert.equal(cardIn(cardB).vanillaData.frontText, 'Qb-later');
        });

        it('applies concurrent highlights to the same document without losing any', async () => {
            const before = (sidecar().highlights ?? []).length;
            await Promise.all([
                highlightsService.createHighlight(docRel, { start: 0, end: 5, color: 'amber' }),
                highlightsService.createHighlight(docRel, { start: 6, end: 9, color: 'green' }),
                highlightsService.createHighlight(docRel, { start: 10, end: 14, color: 'blue' }),
            ]);
            assert.equal((sidecar().highlights ?? []).length, before + 3,
                'a read-modify-write of one sidecar must not drop concurrent siblings');
        });
    });

    // --- 4. Structural operations do not interleave --------------------------------

    describe('a move racing an edit', () => {
        it('holds the whole tree while it runs, and the edit waits for it', async () => {
            const movedRel = path.join(FOLDER, 'moved.md');
            const meta = sidecar();
            const finished = [];

            const moving = docs.move(docRel, movedRel, false)
                .then(() => finished.push('move'), () => finished.push('move'));
            // The move is mid-flight here: it has been entered but not awaited. If it were
            // not taking the tree exclusively, this would be observable as an idle lock.
            assert.equal(isIdle(), false, 'a move in flight must be holding the tree');

            const editing = docs.updateFile(docRel, '# Shared\n\nedited while moving\n', meta)
                .then(() => finished.push('edit'), () => finished.push('edit'));

            // The edit may legitimately fail — issued against a path the move is retiring —
            // but it must not run DURING the move, and the move must not be half-applied.
            await Promise.allSettled([moving, editing]);
            assert.equal(finished[0], 'move', 'an edit must not complete while a move is in flight');
            assert.ok(isIdle(), 'both operations must have released the tree');
            await sealEmitter.quiesce();

            const oldExists = fs.existsSync(docs.files.safePath(docRel));
            const newExists = fs.existsSync(docs.files.safePath(movedRel));
            assert.ok(oldExists !== newExists, 'the document must be at exactly one of the two paths');

            const rel = newExists ? movedRel : docRel;
            const row = await query.getDocumentByPath(rel);
            assert.ok(row, `the index must know the document at ${rel}`);
            assert.ok(fs.existsSync(row.absolute_path), 'the indexed path must exist on disk');
            assert.ok(fs.existsSync(docs.files.safePath(rel + '.flashback')),
                'the sidecar must have travelled with the document');

            // Put it back so later assertions can keep using docRel.
            if (newExists) await docs.move(movedRel, docRel, false);
        });
    });

    // --- 5. What lands in the history ----------------------------------------------

    describe('the Seal history', () => {
        it('records a content edit immediately, without waiting for a timer', async () => {
            const before = await commitCount();
            await docs.updateFile(docRel, '# Shared\n\ncommitted at once\n', sidecar());
            assert.equal(await commitCount(), before + 1,
                'an edit must be committed by the time its request resolves');
        });

        it('still collapses a study session into one commit', async () => {
            await sealEmitter.quiesce();
            const before = await commitCount();

            for (const hash of [cardA, cardB, cardA]) {
                await docs.submitReview(docRel, hash, 1, 2.5, 1);
            }
            await sealEmitter.flushEdits();

            assert.equal(await commitCount(), before + 1,
                'grading cards is coalesced — a session is one commit, as it has always been');
        });
    });
});
