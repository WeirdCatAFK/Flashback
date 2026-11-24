import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import process from 'process';
import { testDataDir } from '../support/testData.js';

const ROOT = testDataDir('conflicts');
process.env.USER_DATA_PATH = ROOT;

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const { default: validate } = await import('../../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const Documents = await import('../../src/api/access/modules/documents.js');
const Highlights = await import('../../src/api/access/modules/highlights.js');
const Decks = await import('../../src/api/access/modules/decks.js');
const deckRows = await import('../../src/api/access/resources/db/decks.js');
const documentRows = await import('../../src/api/access/resources/db/documents.js');
const { default: db } = await import('../../src/api/access/primitives/database.js');
const { PathLock, isIdle, withDocument } = await import('../../src/api/access/resources/pathLock.js');
const Doctor = await import('../../src/api/access/modules/doctor.js');
const { sealTools, sealEmitter } = await import('../../src/api/seal/seal.js');
const { getWorkspacePath } = await import('../../src/api/access/primitives/config.js');
const { ensureManifest } = await import('../../src/api/access/primitives/vault.js');
const Files = await import('../../src/api/access/resources/files.js');

const FOLDER = 'Conflicts';
const docRel = path.join(FOLDER, 'shared.md');

const tick = (ms = 1) => new Promise(r => setTimeout(r, ms));
const LOG_DEPTH = 500;
const commitCount = async () => (await sealTools.log(LOG_DEPTH)).length;
const sidecar = (rel = docRel) => Files.getMetadata(rel) ?? {};
const cardIn = (hash, rel = docRel) => (sidecar(rel).flashcards ?? []).find(c => c.globalHash === hash);

describe('Concurrent writes', () => {
    let cardA, cardB;

    before(async () => {
        ensureManifest();
        await sealTools.init();

        const abs = path.join(getWorkspacePath(), FOLDER);
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
        await Documents.createFolder(FOLDER);

        cardA = crypto.randomUUID();
        cardB = crypto.randomUUID();
        await Documents.importFile('shared.md', FOLDER, Buffer.from('# Shared\n\noriginal body\n'), {
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
        try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {  }
    });


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

        it('makes a Doctor sync wait for an edit in flight', async () => {
            let release;
            const edit = withDocument(docRel, () => new Promise((r) => { release = r; }));
            await tick(1);

            const sync = Doctor.syncIndex({ sealDrift: false });
            const first = await Promise.race([sync.then(() => 'sync'), tick(1500).then(() => 'still waiting')]);
            release();
            await Promise.all([edit, sync]);
            assert.equal(first, 'still waiting', 'the sync must not rewrite the index under a running edit');
        });
    });


    describe('a write that lost the race', () => {
        it('is refused, and changes nothing', async () => {
            const stale = Files.etag(docRel);

            await Documents.updateFile(docRel, '# Shared\n\nfirst writer\n', sidecar(), { ifMatch: stale });
            const body = () => fs.readFileSync(Files.safePath(docRel), 'utf-8');
            assert.match(body(), /first writer/);

            await assert.rejects(
                () => Documents.updateFile(docRel, '# Shared\n\nsecond writer\n', sidecar(), { ifMatch: stale }),
                (err) => {
                    assert.equal(err.status, 409);
                    assert.equal(err.code, 'stale');
                    assert.equal(err.etag, Files.etag(docRel), 'the refusal carries the version the caller needs');
                    return true;
                },
            );
            assert.match(body(), /first writer/, 'the losing write must not have landed');
        });

        it('succeeds once the caller re-reads', async () => {
            const fresh = Files.etag(docRel);
            const { etag } = await Documents.updateFile(docRel, '# Shared\n\nsecond writer\n', sidecar(), { ifMatch: fresh });
            assert.match(fs.readFileSync(Files.safePath(docRel), 'utf-8'), /second writer/);
            assert.equal(etag, Files.etag(docRel), 'the write reports the version it produced');
        });

        it('is not checked at all when the caller sends no version', async () => {
            await Documents.updateFile(docRel, '# Shared\n\nunversioned writer\n', sidecar());
            assert.match(fs.readFileSync(Files.safePath(docRel), 'utf-8'), /unversioned writer/);
        });

        it('does not fail an editor because somebody added a card', async () => {
            const loaded = Files.etag(docRel);
            await Documents.updateFlashcard(docRel, cardB, { frontText: 'added-by-someone-else' });
            assert.notEqual(Files.etag(docRel), loaded, 'the sidecar half moved');

            await Documents.updateFile(docRel, '# Shared\n\nthe editor saves anyway\n', sidecar(), { ifMatch: loaded });
            assert.match(fs.readFileSync(Files.safePath(docRel), 'utf-8'), /the editor saves anyway/);
            assert.equal(cardIn(cardB).vanillaData.frontText, 'added-by-someone-else',
                'and the change it merged is still there');
        });

        it('does fail when the body itself moved on', async () => {
            const loaded = Files.etag(docRel);
            await Documents.updateFile(docRel, '# Shared\n\nsomeone else typed here\n', sidecar());
            await assert.rejects(
                () => Documents.updateFile(docRel, '# Shared\n\nmy stale draft\n', sidecar(), { ifMatch: loaded }),
                (err) => err.status === 409 && err.code === 'stale',
            );
        });

        it('tracks the body as well as the sidecar', async () => {
            const before = Files.etag(docRel);
            fs.writeFileSync(Files.safePath(docRel), '# Shared\n\nchanged outside the app\n');
            assert.notEqual(Files.etag(docRel), before,
                'an edit made outside the app must still invalidate a client\'s version');
        });
    });


    describe('two people patching one document', () => {
        it('both land when they touch different cards', async () => {
            await Promise.all([
                Documents.updateFlashcard(docRel, cardA, { frontText: 'Qa-alice' }),
                Documents.updateFlashcard(docRel, cardB, { frontText: 'Qb-bob' }),
            ]);

            assert.equal(cardIn(cardA).vanillaData.frontText, 'Qa-alice');
            assert.equal(cardIn(cardB).vanillaData.frontText, 'Qb-bob',
                'a patch to another card must not be reverted by its neighbour');
        });

        it('conflict only when they touch the same card', async () => {
            const stale = Documents.cardEtag(docRel, cardA);
            await Documents.updateFlashcard(docRel, cardA, { frontText: 'Qa-first' }, { ifMatch: stale });

            await assert.rejects(
                () => Documents.updateFlashcard(docRel, cardA, { frontText: 'Qa-second' }, { ifMatch: stale }),
                (err) => {
                    assert.equal(err.status, 409);
                    assert.equal(err.code, 'stale');
                    return true;
                },
            );
            assert.equal(cardIn(cardA).vanillaData.frontText, 'Qa-first');

            await Documents.updateFlashcard(docRel, cardB, { frontText: 'Qb-later' });
            assert.equal(cardIn(cardB).vanillaData.frontText, 'Qb-later');
        });

        it('applies concurrent highlights to the same document without losing any', async () => {
            const before = (sidecar().highlights ?? []).length;
            await Promise.all([
                Highlights.createHighlight(docRel, { start: 0, end: 5, color: 'amber' }),
                Highlights.createHighlight(docRel, { start: 6, end: 9, color: 'green' }),
                Highlights.createHighlight(docRel, { start: 10, end: 14, color: 'blue' }),
            ]);
            assert.equal((sidecar().highlights ?? []).length, before + 3,
                'a read-modify-write of one sidecar must not drop concurrent siblings');
        });
    });


    describe('a move racing an edit', () => {
        it('holds the whole tree while it runs, and the edit waits for it', async () => {
            const movedRel = path.join(FOLDER, 'moved.md');
            const meta = sidecar();
            const finished = [];

            const moving = Documents.move(docRel, movedRel, false)
                .then(() => finished.push('move'), () => finished.push('move'));
            assert.equal(isIdle(), false, 'a move in flight must be holding the tree');

            const editing = Documents.updateFile(docRel, '# Shared\n\nedited while moving\n', meta)
                .then(() => finished.push('edit'), () => finished.push('edit'));

            await Promise.allSettled([moving, editing]);
            assert.equal(finished[0], 'move', 'an edit must not complete while a move is in flight');
            assert.ok(isIdle(), 'both operations must have released the tree');
            await sealEmitter.quiesce();

            const oldExists = fs.existsSync(Files.safePath(docRel));
            const newExists = fs.existsSync(Files.safePath(movedRel));
            assert.ok(oldExists !== newExists, 'the document must be at exactly one of the two paths');

            const rel = newExists ? movedRel : docRel;
            const row = await documentRows.getByPath(rel);
            assert.ok(row, `the index must know the document at ${rel}`);
            assert.ok(fs.existsSync(row.absolute_path), 'the indexed path must exist on disk');
            assert.ok(fs.existsSync(Files.safePath(rel + '.flashback')),
                'the sidecar must have travelled with the document');

            if (newExists) await Documents.move(movedRel, docRel, false);
        });
    });


    describe('the Seal history', () => {
        it('records a content edit immediately, without waiting for a timer', async () => {
            const before = await commitCount();
            await Documents.updateFile(docRel, '# Shared\n\ncommitted at once\n', sidecar());
            assert.equal(await commitCount(), before + 1,
                'an edit must be committed by the time its request resolves');
        });

        it('produces no commits for a study session at all', async () => {
            await sealEmitter.quiesce();
            const before = await commitCount();

            for (const hash of [cardA, cardB, cardA]) {
                await Documents.submitReview(docRel, hash, 1, 2.5, 1);
            }
            await sealEmitter.flushEdits();

            assert.equal(await commitCount(), before,
                'studying is not editing — a session is zero commits, not one');
        });
    });


    describe('deck files', () => {
        it("keeps a failed add from erasing a concurrent successful one", async () => {
            await Decks.onVaultOpened();

            const deckHash = await Decks.createDeck('Rollback Race', '');
            const good = await Decks.createStandaloneCard({ frontText: 'survivor', backText: 'b' });
            const bad  = await Decks.createStandaloneCard({ frontText: 'doomed',   backText: 'b' });

            await db.exec(`CREATE TEMP TRIGGER fail_doomed_entry BEFORE INSERT ON DeckEntries
                WHEN NEW.card_hash = '${bad}' BEGIN SELECT RAISE(ABORT, 'simulated DB failure'); END`);

            let settled;
            try {
                settled = await Promise.allSettled([
                    Decks.addEntry(deckHash, { cardHash: bad }),
                    Decks.addEntry(deckHash, { cardHash: good }),
                ]);
            } finally {
                await db.exec('DROP TRIGGER IF EXISTS fail_doomed_entry');
            }

            assert.equal(settled[0].status, 'rejected', 'the doomed add must still fail');
            assert.equal(settled[1].status, 'fulfilled', 'the other add must still succeed');

            const file = JSON.parse(fs.readFileSync(
                path.join(getWorkspacePath(), '_decks', `${deckHash}.json`), 'utf-8'));
            const hashes = file.entries.map(e => e.cardHash);
            assert.deepEqual(hashes, [good],
                "the failed add's rollback must not erase the successful add from the deck file");

            const row = await deckRows.getByHash(deckHash);
            const inDb = (await deckRows.getEntries(row.id, 'owner')).map(e => e.card_hash);
            assert.deepEqual(inDb, [good],
                'the portable file and the index must agree about what the deck holds');
        });
    });
});
