/**
 * Canonical updates — the versioned migration system for the `.flashback` sidecars and
 * `_decks/*.json` files (src/api/config/UpdateRunner.js + config/updates/).
 *
 * Two halves, deliberately:
 *
 *   1. The MECHANISM, driven with synthetic updates injected into the runner. This is what
 *      every future update inherits, so it is tested independently of the one update that
 *      happens to exist today: ordering, per-item versioning, the stamp, the vault-level
 *      fast path, and the failure behaviour that decides whether a bad file can damage a
 *      vault or block one.
 *   2. Update 001 itself, run through the real registry against a legacy vault.
 *
 * Run: node --test tests/updates.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data_test_updates');

const { default: validate } = await import('../src/api/config/validate.js');
if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const { default: Documents } = await import('../src/api/access/orchestration/documents.js');
const { default: Decks } = await import('../src/api/access/orchestration/decks.js');
const { default: Doctor } = await import('../src/api/access/orchestration/doctor.js');
const { default: query } = await import('../src/api/access/resources/query.js');
const { default: db } = await import('../src/api/access/primitives/database.js');
const { sealTools } = await import('../src/api/seal/seal.js');
const { getWorkspacePath } = await import('../src/api/access/primitives/config.js');
const { default: runUpdates } = await import('../src/api/config/UpdateRunner.js');
const { LATEST_VERSION, pendingFor } = await import('../src/api/config/updates/registry.js');
const u001 = await import('../src/api/config/updates/001_type_answer_split.js');

const docs = new Documents();
const decks = new Decks();
const doctor = new Doctor();
const workspace = getWorkspacePath();

const abs = (...p) => path.join(workspace, ...p);
const readSidecar = (relPath) => JSON.parse(fs.readFileSync(abs(relPath + '.flashback'), 'utf-8'));
const readFolderSidecar = (relPath) => JSON.parse(fs.readFileSync(abs(relPath, '.flashback'), 'utf-8'));
const deckFilePath = (hash) => abs('_decks', `${hash}.json`);
const readDeckFile = (hash) => JSON.parse(fs.readFileSync(deckFilePath(hash), 'utf-8'));

// Forces the vault back to "nothing has ever run" so a test can drive a pass from scratch.
const forgetVaultVersions = async () => await db.prepare('DELETE FROM CanonicalVersion').run();

// Rewrites a sidecar the way a build that predates versioning would have left it.
const deVersion = (relPath) => {
    const meta = readSidecar(relPath);
    delete meta.formatVersion;
    fs.writeFileSync(abs(relPath + '.flashback'), JSON.stringify(meta, null, 2));
    return meta;
};

// A type_answer card as an older Flashback wrote it: the answer sits in backText and there
// is no answerText key at all.
const legacyCard = (globalHash, question, answer) => ({
    globalHash,
    name: question,
    cardType: 'type_answer',
    level: 0,
    lastRecall: null,
    tags: [],
    vanillaData: {
        frontText: question,
        backText: answer,
        media: { front_img: null, back_img: null, front_sound: null, back_sound: null },
    },
    customData: { html: '' },
});

describe('Canonical updates', () => {

    before(async () => {
        await sealTools.init();
    });

    after(async () => {
        db.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            fs.rmSync(process.env.USER_DATA_PATH, { recursive: true, force: true });
        } catch (e) {
            console.warn('Teardown warning (safe to ignore):', e.message);
        }
    });

    // ── 1. THE MECHANISM ──────────────────────────────────────────────────────
    //
    // Synthetic updates: each one tags the file it touched so the assertions can see
    // exactly which ran, in what order, and against which items.

    describe('the runner (driven with synthetic updates)', () => {
        const ROOT = 'MechanismTests';
        const docRel = path.join(ROOT, 'Note.md');
        const seen = [];

        // Two updates whose versions straddle a file's stamp, so "apply only what this item
        // still needs" is observable rather than inferred.
        const mkUpdate = (version) => ({
            version,
            description: `synthetic ${version}`,
            up(meta, kind) {
                seen.push({ version, kind, at: seen.length });
                meta.trail = [...(meta.trail ?? []), version];
                return true;
            },
        });
        const updates = [mkUpdate(1), mkUpdate(2)];

        before(async () => {
            try { if (docs.exists(ROOT, true, true)) await docs.delete(ROOT, true); } catch { /* clean slate */ }
            await docs.createFolder(ROOT);
            await docs.createFile('Note.md', ROOT);
            await forgetVaultVersions();
        });

        it('stamps a brand-new sidecar at creation, without any update running', () => {
            assert.equal(readSidecar(docRel).formatVersion, LATEST_VERSION);
            assert.equal(readFolderSidecar(ROOT).formatVersion, LATEST_VERSION);
        });

        it('applies pending updates in ascending order, to documents, folders and decks', async () => {
            deVersion(docRel);                       // pretend this file predates versioning
            seen.length = 0;

            const r = await runUpdates({ updates, seal: false });

            assert.equal(r.walked, true);
            assert.deepEqual(r.pending, [1, 2]);
            assert.ok(r.documents >= 1, 'the document was rewritten');
            assert.ok(r.folders >= 1, 'folder sidecars are versioned too');

            const forDoc = seen.filter(s => s.kind === 'document').map(s => s.version);
            assert.deepEqual(forDoc.slice(0, 2), [1, 2], 'ascending, never skipping one');
            assert.ok(seen.some(s => s.kind === 'folder'), 'folders are visited');
            assert.ok(seen.some(s => s.kind === 'deck'), 'deck files are visited');

            const meta = readSidecar(docRel);
            assert.deepEqual(meta.trail, [1, 2], 'both updates touched the file, in order');
            assert.equal(meta.formatVersion, 2, 'and it is stamped with where it now stands');
        });

        it('applies only what an item still needs, judged per item', async () => {
            // One file left behind at version 1 while the vault has moved to 2. This is the
            // case a vault-level marker cannot express: a Seal rollback, a restored backup,
            // a file synced in from another machine.
            const meta = readSidecar(docRel);
            meta.formatVersion = 1;
            meta.trail = [1];
            fs.writeFileSync(abs(docRel + '.flashback'), JSON.stringify(meta, null, 2));
            seen.length = 0;

            await runUpdates({ updates, force: true, seal: false });

            const after = readSidecar(docRel);
            assert.deepEqual(after.trail, [1, 2], 'update 2 ran, update 1 did not run again');
            assert.equal(after.formatVersion, 2);
        });

        it('leaves an already-current item completely alone', async () => {
            const before = fs.readFileSync(abs(docRel + '.flashback'), 'utf-8');
            seen.length = 0;

            await runUpdates({ updates, force: true, seal: false });

            assert.equal(seen.filter(s => s.kind === 'document').length, 0, 'no update was invoked');
            assert.equal(fs.readFileSync(abs(docRel + '.flashback'), 'utf-8'), before, 'byte-identical');
        });

        it('records the vault version and then skips the walk entirely', async () => {
            assert.deepEqual([...await query.getCanonicalVersions()].sort(), [1, 2]);

            const r = await runUpdates({ updates, seal: false });
            assert.equal(r.walked, false, 'the steady state costs one indexed read, not a walk');
            assert.deepEqual(r.pending, []);
        });

        it('walks again as soon as a newer update appears', async () => {
            const r = await runUpdates({ updates: [...updates, mkUpdate(3)], seal: false });
            assert.deepEqual(r.pending, [3], 'only the new one is pending');
            assert.equal(r.walked, true);
            assert.deepEqual(readSidecar(docRel).trail, [1, 2, 3]);
            assert.equal(readSidecar(docRel).formatVersion, 3);
        });

        it('leaves a file untouched when its update throws, and does not record the version', async () => {
            const boom = {
                version: 9,
                description: 'always throws',
                up(meta, kind) {
                    if (kind !== 'document') return false;
                    throw new Error('synthetic failure');
                },
            };
            const before = fs.readFileSync(abs(docRel + '.flashback'), 'utf-8');

            const r = await runUpdates({ updates: [...updates, boom], seal: false });

            assert.equal(fs.readFileSync(abs(docRel + '.flashback'), 'utf-8'), before,
                'a failed transform never half-writes the file');
            assert.ok(r.warnings.some(w => w.includes('synthetic failure')), 'the failure is reported');
            assert.equal(r.recorded, false, 'an incomplete pass is not recorded as done');
            assert.ok(!(await await query.getCanonicalVersions()).has(9), 'so the next launch tries again');
        });

        it('skips an unparseable sidecar without overwriting it', async () => {
            const corruptRel = path.join(ROOT, 'Corrupt.md');
            fs.writeFileSync(abs(corruptRel), '# Corrupt');
            fs.writeFileSync(abs(corruptRel + '.flashback'), '{ this is not json');
            const before = fs.readFileSync(abs(corruptRel + '.flashback'), 'utf-8');

            const r = await runUpdates({ updates, force: true, seal: false });

            assert.equal(fs.readFileSync(abs(corruptRel + '.flashback'), 'utf-8'), before);
            assert.ok(r.warnings.some(w => w.includes('Corrupt.md')), 'reported, not silently dropped');
            assert.equal(r.recorded, false);

            fs.rmSync(abs(corruptRel + '.flashback'));
            fs.rmSync(abs(corruptRel));
        });

        it('pendingFor is the ordering rule the runner relies on', () => {
            assert.deepEqual(pendingFor(0, updates).map(u => u.version), [1, 2]);
            assert.deepEqual(pendingFor(1, updates).map(u => u.version), [2]);
            assert.deepEqual(pendingFor(2, updates).map(u => u.version), []);
            assert.deepEqual(pendingFor(undefined, updates).map(u => u.version), [1, 2],
                'a file with no stamp is version 0');
        });
    });

    // ── 2. THE COST OF THE WALK ───────────────────────────────────────────────

    describe('walk cost', () => {
        const ROOT = 'ScaleTest';
        const COUNT = 300;

        before(async () => {
            try { if (docs.exists(ROOT, true, true)) await docs.delete(ROOT, true); } catch { /* clean slate */ }
            await docs.createFolder(ROOT);
            // Written straight to disk: this measures the runner, not document creation.
            for (let i = 0; i < COUNT; i++) {
                const rel = path.join(ROOT, `note-${i}.md`);
                fs.writeFileSync(abs(rel), `# Note ${i}`);
                fs.writeFileSync(abs(rel + '.flashback'), JSON.stringify({
                    globalHash: crypto.randomUUID(), tags: [], excludedTags: [],
                    flashcards: [legacyCard(crypto.randomUUID(), `q${i}`, `a${i}`)],
                    highlights: [], links: [], encoding: 'UTF-8',
                }, null, 2));
            }
        });

        it(`reads and stamps ${COUNT} sidecars in a reasonable time`, async () => {
            const noop = [{ version: 1, description: 'noop', up: () => false }];
            await forgetVaultVersions();

            const started = Date.now();
            const r = await runUpdates({ updates: noop, seal: false });
            const elapsed = Date.now() - started;

            assert.ok(r.documents >= COUNT, `all ${COUNT} sidecars were stamped`);
            console.log(`    walked + stamped ${r.documents} sidecars in ${elapsed}ms`);
            // Loose on purpose — this is a regression tripwire for something pathological
            // (an O(n²) walk, a per-file DB round trip), not a benchmark.
            assert.ok(elapsed < 15000, `walk took ${elapsed}ms`);
        });

        // The number behind the design: what a walk costs when it finds nothing to do.
        // This is the cost of *reading* every sidecar, which is what the fast path avoids
        // and what a `force` re-check would actually pay.
        it('re-reads every sidecar quickly when nothing needs writing', async () => {
            const noop = [{ version: 1, description: 'noop', up: () => false }];

            const started = Date.now();
            const r = await runUpdates({ updates: noop, force: true, seal: false });
            const elapsed = Date.now() - started;

            assert.equal(r.documents, 0, 'nothing to rewrite the second time');
            console.log(`    read-only walk of ${COUNT}+ sidecars: ${elapsed}ms`);
            assert.ok(elapsed < 5000, `read-only walk took ${elapsed}ms`);
        });

        it('costs nothing at all once the vault is recorded', async () => {
            const started = Date.now();
            const r = await runUpdates({ updates: [{ version: 1, description: 'noop', up: () => false }], seal: false });
            const elapsed = Date.now() - started;

            assert.equal(r.walked, false);
            console.log(`    steady-state startup check: ${elapsed}ms`);
            assert.ok(elapsed < 250, `fast path took ${elapsed}ms`);
        });

        after(async () => {
            try { await docs.delete(ROOT, true); } catch { /* best effort */ }
            fs.rmSync(abs(ROOT), { recursive: true, force: true });
            await forgetVaultVersions();
        });
    });

    // ── 3. UPDATE 001, THROUGH THE REAL REGISTRY ──────────────────────────────

    describe('001 — type_answer split', () => {
        const ROOT = 'TypeAnswerUpdate';
        const docRel = path.join(ROOT, 'Kana.md');
        const docCardHash = crypto.randomUUID();
        let standaloneHash;
        let systemDeckHash;
        let result;

        before(async () => {
            try { if (docs.exists(ROOT, true, true)) await docs.delete(ROOT, true); } catch { /* clean slate */ }
            await docs.createFolder(ROOT);

            // A document-anchored legacy card, written straight into the sidecar and then
            // indexed — the state an older version left behind.
            await docs.createFile('Kana.md', ROOT);
            const meta = docs.files.getMetadata(docRel) || {};
            meta.flashcards = [legacyCard(docCardHash, 'か', 'ka')];
            delete meta.formatVersion;
            fs.writeFileSync(abs(docRel + '.flashback'), JSON.stringify(meta, null, 2));
            await docs.reindexDocument(docRel);

            // A standalone legacy card: created normally, then pushed back into the
            // pre-split shape in its deck file, its inline snapshot and its derived row.
            standaloneHash = await decks.createStandaloneCard({
                frontText: 'き', backText: 'ki', cardType: 'type_answer', name: 'き',
            });
            systemDeckHash = (await query.getSystemDeck()).global_hash;

            const deckFile = readDeckFile(systemDeckHash);
            delete deckFile.formatVersion;
            const entry = deckFile.entries.find(e => e.cardHash === standaloneHash);
            delete entry.card.vanillaData.answerText;
            entry.card.vanillaData.backText = 'ki';
            fs.writeFileSync(deckFilePath(systemDeckHash), JSON.stringify(deckFile, null, 2));
            await query.updateDeckEntryInlineCard((await query.getSystemDeck()).id, standaloneHash, JSON.stringify(entry.card));
            await db.prepare(`
                UPDATE FlashcardContent SET backText = 'ki', answerText = NULL
                 WHERE id = (SELECT content_id FROM Flashcards WHERE global_hash = ?)
            `).run(standaloneHash);

            await forgetVaultVersions();
            result = await runUpdates();
        });

        it('splits a document-anchored card and stamps its sidecar', () => {
            const meta = readSidecar(docRel);
            const card = meta.flashcards.find(f => f.globalHash === docCardHash);
            assert.equal(card.vanillaData.answerText, 'ka');
            assert.equal(card.vanillaData.backText, '');
            assert.equal(meta.formatVersion, LATEST_VERSION);
        });

        it('splits a standalone card in its deck file and stamps that too', () => {
            const file = readDeckFile(systemDeckHash);
            const entry = file.entries.find(e => e.cardHash === standaloneHash);
            assert.equal(entry.card.vanillaData.answerText, 'ki');
            assert.equal(entry.card.vanillaData.backText, '');
            assert.equal(file.formatVersion, LATEST_VERSION);
        });

        it('brings the derived rows and inline snapshots in line with the files', async () => {
            for (const [hash, answer] of [[docCardHash, 'ka'], [standaloneHash, 'ki']]) {
                const row = await query.getFlashcardContentByHash(hash);
                assert.equal(row.answerText, answer, `answerText for ${hash}`);
                assert.equal(row.backText, null, `backText for ${hash}`);
            }

            const entries = await query.getDeckEntries((await query.getSystemDeck()).id);
            const inline = JSON.parse(entries.find(e => e.card_hash === standaloneHash).inline_card);
            assert.equal(inline.vanillaData.answerText, 'ki');
        });

        it('binds the whole pass into a single reconcile commit', async () => {
            const commits = await sealTools.log(1000);
            const reconciles = commits.filter(c => c.commit.message.startsWith('reconcile:'));
            assert.equal(reconciles.length, 1, 'one commit for the pass, not one per file');
            assert.equal(commits[0].oid, result.sealedOid);
        });

        it('records the vault version and leaves nothing pending', async () => {
            assert.equal(result.recorded, true);
            assert.deepEqual(result.warnings, []);
            assert.ok((await await query.getCanonicalVersions()).has(u001.version));
        });

        it('is idempotent per card, even forced back over the same files', async () => {
            const sidecarBefore = fs.readFileSync(abs(docRel + '.flashback'), 'utf-8');
            const deckBefore = fs.readFileSync(deckFilePath(systemDeckHash), 'utf-8');

            await forgetVaultVersions();
            const again = await runUpdates({ force: true });

            assert.equal(fs.readFileSync(abs(docRel + '.flashback'), 'utf-8'), sidecarBefore,
                'a migrated answer is never pushed back into the notes');
            assert.equal(fs.readFileSync(deckFilePath(systemDeckHash), 'utf-8'), deckBefore);
            assert.equal(again.sealedOid, null, 'nothing changed, so nothing to seal');
        });

        it('splitCard leaves a card that already has an answer alone', () => {
            const card = legacyCard('h', 'q', 'notes about the answer');
            card.vanillaData.answerText = 'a';
            assert.equal(u001.splitCard(card), false);
            assert.equal(card.vanillaData.answerText, 'a');
            assert.equal(card.vanillaData.backText, 'notes about the answer');
        });

        it('ignores every other card type', () => {
            const card = legacyCard('h', 'q', 'a');
            card.cardType = 'basic';
            assert.equal(u001.splitCard(card), false);
            assert.equal(card.vanillaData.backText, 'a');
            assert.equal(card.vanillaData.answerText, undefined);
        });

        it('leaves the Vault Doctor with no drift afterwards', async () => {
            const report = await doctor.checkIndex();
            assert.deepEqual(report.documents.modified, [], 'the two layers agree');
            assert.deepEqual(report.documents.missingInDb, []);
            assert.deepEqual(report.documents.orphanedInDb, []);
        });
    });
});
