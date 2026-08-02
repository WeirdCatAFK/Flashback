import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import validate from '../src/api/config/validate.js';
import Documents from '../src/api/access/documents.js';
import Decks from '../src/api/access/decks.js';
import db from '../src/api/access/database.js';
import query from '../src/api/access/query.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/config.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const decks = new Decks();

const makeCards = (n) => Array.from({ length: n }, (_, i) => ({
    globalHash: crypto.randomUUID(),
    level: 0,
    vanillaData: { frontText: `Q${i}`, backText: `A${i}` },
}));

const rmWorkspace = (name) => {
    try {
        const absPath = path.join(getWorkspacePath(), name);
        if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
    } catch { /* ignore */ }
};

// ── Correctness ───────────────────────────────────────────────────────────────

describe('Tag propagation — correctness', () => {
    const ROOT = 'TagTestWorkspace';

    before(async () => {
        rmWorkspace(ROOT);
        await sealTools.init();
        await docs.createFolder(ROOT);
    });

    after(() => rmWorkspace(ROOT));

    it('folder tag propagates to child documents and their flashcards via updateMetadata', async () => {
        await docs.createFolder('Science', ROOT);
        const folderPath = path.join(ROOT, 'Science');
        await docs.createFolder('Biology', folderPath);
        const subFolderPath = path.join(folderPath, 'Biology');

        await docs.importFile('cells.md', subFolderPath, Buffer.from('# Cells'), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(3),
        });

        await docs.updateMetadata(folderPath, { tags: ['biology', 'science'] }, true);

        const docEntity = query.getDocumentByPath(path.join(subFolderPath, 'cells.md'));
        assert.ok(docEntity, 'Document should exist');

        const docInherited = query.getInheritedTagNames(docEntity.node_id);
        assert.ok(docInherited.includes('biology'), 'Document should inherit "biology"');
        assert.ok(docInherited.includes('science'), 'Document should inherit "science"');

        const flashcards = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(docEntity.id);
        assert.equal(flashcards.length, 3);

        for (const fc of flashcards) {
            const inherited = query.getInheritedTagNames(fc.node_id);
            assert.ok(inherited.includes('biology'), `FC ${fc.node_id} should inherit "biology"`);
            assert.ok(inherited.includes('science'), `FC ${fc.node_id} should inherit "science"`);
        }
    });

    it('superSearch tag: filter finds flashcards via InheritedTags', () => {
        const results = query.superSearch({ tag: 'biology', limit: 50 });
        assert.ok(Array.isArray(results.flashcards));
        assert.ok(results.flashcards.length >= 3,
            `Should find ≥3 flashcards; got ${results.flashcards.length}`);
        console.log(`  tag:biology search → ${results.flashcards.length} flashcard(s)`);
    });

    it('graph edges include inherited tag edges for flashcards', () => {
        const { nodes, edges } = query.getGraphData();

        const biologyTag = nodes.find(n => n.type === 'Tag' && n.label === 'biology');
        assert.ok(biologyTag, '"biology" tag node should be in graph');

        const flashcardNodes = new Set(nodes.filter(n => n.type === 'Flashcard').map(n => n.id));
        const fcTagEdges = edges.filter(e =>
            e.toId === biologyTag.id && flashcardNodes.has(e.fromId) && e.relation === 'tag'
        );

        assert.ok(fcTagEdges.length >= 3,
            `Graph should have ≥3 flashcard→biology edges; got ${fcTagEdges.length}`);
        console.log(`  Graph: ${fcTagEdges.length} flashcard→biology edge(s)`);
    });

    it('excluded tag on subfolder blocks propagation to its children', async () => {
        await docs.createFolder('History', ROOT);
        const histPath = path.join(ROOT, 'History');
        await docs.createFolder('Blocked', histPath);
        const blockedPath = path.join(histPath, 'Blocked');

        await docs.importFile('knights.md', blockedPath, Buffer.from('# Knights'), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(2),
        });

        // Tag History — propagates to knights.md flashcards
        await docs.updateMetadata(histPath, { tags: ['history'] }, true);

        const docBefore = query.getDocumentByPath(path.join(blockedPath, 'knights.md'));
        const fcsBefore = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(docBefore.id);
        for (const fc of fcsBefore) {
            const tags = query.getInheritedTagNames(fc.node_id);
            assert.ok(tags.includes('history'), 'Should have history before exclusion');
        }

        // Block 'history' on the Blocked folder
        await docs.updateMetadata(blockedPath, { tags: [], excludedTags: ['history'] }, true);

        const docAfter = query.getDocumentByPath(path.join(blockedPath, 'knights.md'));
        const fcsAfter = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(docAfter.id);
        for (const fc of fcsAfter) {
            const tags = query.getInheritedTagNames(fc.node_id);
            assert.ok(!tags.includes('history'),
                `FC ${fc.node_id} should NOT have "history" after exclusion`);
        }
        console.log('  Exclusion correctly blocked "history" from Blocked/ subtree');
    });

    it('document-level tag propagates to its own flashcards', async () => {
        await docs.createFolder('Physics', ROOT);
        const physPath = path.join(ROOT, 'Physics');

        await docs.importFile('quantum.md', physPath, Buffer.from('# Quantum'), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(4),
        });

        await docs.updateMetadata(path.join(physPath, 'quantum.md'), { tags: ['quantum', 'physics'] }, false);

        const docEntity = query.getDocumentByPath(path.join(physPath, 'quantum.md'));
        const flashcards = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(docEntity.id);
        assert.equal(flashcards.length, 4);

        for (const fc of flashcards) {
            const inherited = query.getInheritedTagNames(fc.node_id);
            assert.ok(inherited.includes('quantum'), `FC ${fc.node_id} should inherit "quantum"`);
            assert.ok(inherited.includes('physics'), `FC ${fc.node_id} should inherit "physics"`);
        }
        console.log('  Document-level tags propagated to all 4 flashcards');
    });

    // ── Propagation at CREATION time ─────────────────────────────────────────
    // Regression: propagation only ever ran from updateMetadata, i.e. when a tag was
    // written. Anything created afterwards under an already-tagged parent got an
    // inheritance edge with no tags on it, and stayed untagged until someone happened
    // to re-save the parent. These cover the create-then-tag order the old tests all
    // used, reversed.

    it('a flashcard created after its document was tagged inherits at creation', async () => {
        await docs.createFolder('LateCards', ROOT);
        const base = path.join(ROOT, 'LateCards');

        await docs.importFile('late.md', base, Buffer.from('# Late'), {
            globalHash: crypto.randomUUID(),
        });
        const docRel = path.join(base, 'late.md');

        // Tag FIRST, add the card SECOND.
        await docs.updateMetadata(docRel, { tags: ['chemistry'] }, false);
        const saved = await docs.createFlashcard(docRel, {
            cardType: 'basic',
            vanillaData: { frontText: 'Q-late', backText: 'A-late' },
        });

        const docEntity = query.getDocumentByPath(docRel);
        const fc = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ? AND global_hash = ?')
            .get(docEntity.id, saved.globalHash);
        assert.ok(fc, 'card should be registered in the derived layer');
        assert.ok(query.getInheritedTagNames(fc.node_id).includes('chemistry'),
            'card created after tagging should inherit "chemistry" immediately');
        console.log('  Late-created card inherited "chemistry"');
    });

    it('a flashcard created after a FOLDER was tagged inherits through the document', async () => {
        await docs.createFolder('LateFolderCards', ROOT);
        const folderRel = path.join(ROOT, 'LateFolderCards');

        await docs.importFile('host.md', folderRel, Buffer.from('# Host'), {
            globalHash: crypto.randomUUID(),
        });
        const docRel = path.join(folderRel, 'host.md');

        await docs.updateMetadata(folderRel, { tags: ['geology'] }, true);
        const saved = await docs.createFlashcard(docRel, {
            cardType: 'basic',
            vanillaData: { frontText: 'Q-geo', backText: 'A-geo' },
        });

        const docEntity = query.getDocumentByPath(docRel);
        const fc = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ? AND global_hash = ?')
            .get(docEntity.id, saved.globalHash);
        assert.ok(query.getInheritedTagNames(fc.node_id).includes('geology'),
            'card should inherit the folder tag through its document at creation');
        console.log('  Late-created card inherited folder tag "geology"');
    });

    it('a document imported into an already-tagged folder inherits at creation', async () => {
        await docs.createFolder('PreTagged', ROOT);
        const folderRel = path.join(ROOT, 'PreTagged');

        // Tag the empty folder FIRST.
        await docs.updateMetadata(folderRel, { tags: ['astronomy'] }, true);

        await docs.importFile('stars.md', folderRel, Buffer.from('# Stars'), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(2),
        });
        const docRel = path.join(folderRel, 'stars.md');

        const docEntity = query.getDocumentByPath(docRel);
        assert.ok(query.getInheritedTagNames(docEntity.node_id).includes('astronomy'),
            'document imported into a tagged folder should inherit at creation');

        const flashcards = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(docEntity.id);
        assert.equal(flashcards.length, 2);
        for (const fc of flashcards) {
            assert.ok(query.getInheritedTagNames(fc.node_id).includes('astronomy'),
                'its sidecar cards should inherit too');
        }
        console.log('  Document + cards imported into tagged folder inherited "astronomy"');
    });

    it('a folder created inside an already-tagged folder inherits, and passes it on', async () => {
        await docs.createFolder('PreTaggedParent', ROOT);
        const parentRel = path.join(ROOT, 'PreTaggedParent');
        await docs.updateMetadata(parentRel, { tags: ['literature'] }, true);

        await docs.createFolder('Child', parentRel);
        const childRel = path.join(parentRel, 'Child');

        const childFolder = query.getFolderByPath(childRel);
        assert.ok(query.getInheritedTagNames(childFolder.node_id).includes('literature'),
            'subfolder created under a tagged folder should inherit at creation');

        // And the tag must keep flowing to what's created inside the new subfolder.
        await docs.importFile('poems.md', childRel, Buffer.from('# Poems'), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(1),
        });
        const grandchild = query.getDocumentByPath(path.join(childRel, 'poems.md'));
        assert.ok(query.getInheritedTagNames(grandchild.node_id).includes('literature'),
            'a document under the new subfolder should inherit too');
        console.log('  Subfolder and its contents inherited "literature"');
    });

    it('an exclusion on the parent still blocks a newly created child', async () => {
        await docs.createFolder('ExcludeParent', ROOT);
        const parentRel = path.join(ROOT, 'ExcludeParent');
        await docs.updateMetadata(parentRel, { tags: ['blocked-tag'] }, true);

        await docs.createFolder('Shielded', parentRel);
        const shieldedRel = path.join(parentRel, 'Shielded');
        await docs.updateMetadata(shieldedRel, { tags: [], excludedTags: ['blocked-tag'] }, true);

        // Created AFTER the exclusion was set — must not pick the tag up.
        await docs.importFile('quiet.md', shieldedRel, Buffer.from('# Quiet'), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(1),
        });
        const docEntity = query.getDocumentByPath(path.join(shieldedRel, 'quiet.md'));
        assert.ok(!query.getInheritedTagNames(docEntity.node_id).includes('blocked-tag'),
            'exclusion must apply to documents created after it, not just existing ones');

        const [fc] = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(docEntity.id);
        assert.ok(!query.getInheritedTagNames(fc.node_id).includes('blocked-tag'),
            'and to their cards');
        console.log('  Exclusion held against a newly created document');
    });

    it('moving a document into a tagged folder re-inherits for it and its cards', async () => {
        await docs.createFolder('MoveSource', ROOT);
        await docs.createFolder('MoveTarget', ROOT);
        const sourceRel = path.join(ROOT, 'MoveSource');
        const targetRel = path.join(ROOT, 'MoveTarget');
        await docs.updateMetadata(targetRel, { tags: ['archived'] }, true);

        await docs.importFile('wanderer.md', sourceRel, Buffer.from('# Wanderer'), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(2),
        });
        const fromRel = path.join(sourceRel, 'wanderer.md');
        const toRel = path.join(targetRel, 'wanderer.md');

        const before = query.getDocumentByPath(fromRel);
        assert.ok(!query.getInheritedTagNames(before.node_id).includes('archived'),
            'precondition: not tagged before the move');

        await docs.move(fromRel, toRel, false);

        const after = query.getDocumentByPath(toRel);
        assert.ok(query.getInheritedTagNames(after.node_id).includes('archived'),
            'moved document should inherit its new parent\'s tags');
        const flashcards = db.prepare('SELECT node_id FROM Flashcards WHERE document_id = ?').all(after.id);
        assert.equal(flashcards.length, 2);
        for (const fc of flashcards) {
            assert.ok(query.getInheritedTagNames(fc.node_id).includes('archived'),
                'and so should its cards');
        }
        console.log('  Moved document + cards picked up "archived"');
    });

    it('tag with no remaining references disappears from getAllTags', async () => {
        await docs.createFolder('Orphans', ROOT);
        const orphPath = path.join(ROOT, 'Orphans');

        await docs.importFile('lonely.md', orphPath, Buffer.from('# Lonely'), {
            globalHash: crypto.randomUUID(),
        });
        const docRel = path.join(orphPath, 'lonely.md');

        await docs.updateMetadata(docRel, { tags: ['ephemeral', 'kept'] }, false);
        assert.ok(query.getAllTags().includes('ephemeral'), 'tag should exist after being added');

        // Remove only "ephemeral"; nothing else references it, so it must be gone.
        await docs.updateMetadata(docRel, { tags: ['kept'] }, false);
        const tags = query.getAllTags();
        assert.ok(!tags.includes('ephemeral'), '"ephemeral" should be pruned once unreferenced');
        assert.ok(tags.includes('kept'), '"kept" should remain');
        console.log('  Unreferenced tag pruned from getAllTags');
    });

    it('shared tag survives while any reference remains', async () => {
        await docs.createFolder('SharedTag', ROOT);
        const base = path.join(ROOT, 'SharedTag');

        await docs.importFile('a.md', base, Buffer.from('# A'), { globalHash: crypto.randomUUID() });
        await docs.importFile('b.md', base, Buffer.from('# B'), { globalHash: crypto.randomUUID() });
        const aRel = path.join(base, 'a.md');
        const bRel = path.join(base, 'b.md');

        await docs.updateMetadata(aRel, { tags: ['shared'] }, false);
        await docs.updateMetadata(bRel, { tags: ['shared'] }, false);

        // Remove from a — b still references it, so it must stay.
        await docs.updateMetadata(aRel, { tags: [] }, false);
        assert.ok(query.getAllTags().includes('shared'), 'shared tag should survive while b references it');

        // Remove from b — now orphaned, should vanish.
        await docs.updateMetadata(bRel, { tags: [] }, false);
        assert.ok(!query.getAllTags().includes('shared'), 'shared tag should be pruned once fully unreferenced');
        console.log('  Shared tag pruned only after last reference removed');
    });
});

// ── Deck tag propagation ────────────────────────────────────────────────────────

describe('Deck tag propagation — correctness', () => {
    const ROOT = 'DeckTagWorkspace';
    let deckHash;
    let cardRows = [];          // cards seeded into a document and added to the deck
    let extraCard;              // a card added to the deck AFTER tags were set
    let docRel;

    // Reads the current global_hash + node_id for every flashcard under a document.
    const cardsForDoc = (relPath) => {
        const doc = query.getDocumentByPath(relPath);
        return db.prepare('SELECT global_hash, node_id FROM Flashcards WHERE document_id = ?').all(doc.id);
    };

    before(async () => {
        rmWorkspace(ROOT);
        await sealTools.init();
        await docs.createFolder(ROOT);

        await docs.importFile('deck-cards.md', ROOT, Buffer.from('# Deck cards'), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(3),
        });
        docRel = path.join(ROOT, 'deck-cards.md');
        cardRows = cardsForDoc(docRel);

        // A separate card we'll add to the deck only after tagging it.
        await docs.importFile('late-card.md', ROOT, Buffer.from('# Late'), {
            globalHash: crypto.randomUUID(),
            flashcards: makeCards(1),
        });
        [extraCard] = cardsForDoc(path.join(ROOT, 'late-card.md'));

        deckHash = await decks.createDeck('Study Deck');
        for (const c of cardRows) {
            await decks.addEntry(deckHash, { cardHash: c.global_hash, documentPath: docRel });
        }
    });

    after(() => rmWorkspace(ROOT));

    it('deck tags flow down to member cards', async () => {
        await decks.setTags(deckHash, ['exam2026']);

        const deck = query.getDeckByHash(deckHash);
        assert.deepEqual(query.getDirectTagNames(deck.node_id), ['exam2026'],
            'deck node should carry the direct tag');

        for (const c of cardRows) {
            assert.ok(query.getInheritedTagNames(c.node_id).includes('exam2026'),
                `card ${c.global_hash} should inherit "exam2026" from its deck`);
        }
        console.log('  Deck tag "exam2026" propagated to 3 member cards');
    });

    it('deck tags compose with document tags (union, no clobber)', async () => {
        await docs.updateMetadata(docRel, { tags: ['sourcedoc'] }, false);

        for (const c of cardRows) {
            const tags = query.getInheritedTagNames(c.node_id);
            assert.ok(tags.includes('exam2026'), 'deck tag should survive a document-tag change');
            assert.ok(tags.includes('sourcedoc'), 'document tag should coexist with the deck tag');
        }
        console.log('  Cards carry the union of deck + document tags');
    });

    it('a card added after tagging inherits the deck tags immediately', async () => {
        await decks.addEntry(deckHash, { cardHash: extraCard.global_hash, documentPath: path.join(ROOT, 'late-card.md') });
        assert.ok(query.getInheritedTagNames(extraCard.node_id).includes('exam2026'),
            'late-added card should inherit the deck tag on entry');
        console.log('  Late-added card inherited "exam2026"');
    });

    it('superSearch tag: finds cards via deck-inherited tags', () => {
        const results = query.superSearch({ tag: 'exam2026', limit: 50 });
        assert.ok(results.flashcards.length >= 4,
            `Should find ≥4 cards tagged via deck; got ${results.flashcards.length}`);
        console.log(`  tag:exam2026 search → ${results.flashcards.length} card(s)`);
    });

    it('graph shows card→tag edges for deck-inherited tags', () => {
        const { nodes, edges } = query.getGraphData();
        const tagNode = nodes.find(n => n.type === 'Tag' && n.label === 'exam2026');
        assert.ok(tagNode, '"exam2026" tag node should be in graph');
        const cardNodeIds = new Set(cardRows.map(c => c.node_id));
        const cardTagEdges = edges.filter(e =>
            e.toId === tagNode.id && cardNodeIds.has(e.fromId) && e.relation === 'tag');
        assert.ok(cardTagEdges.length >= 3,
            `Graph should have ≥3 card→exam2026 edges; got ${cardTagEdges.length}`);
        console.log(`  Graph: ${cardTagEdges.length} card→exam2026 edge(s)`);
    });

    it('removing a card from the deck drops the deck tag but keeps document tags', async () => {
        const target = cardRows[0];
        await decks.removeEntry(deckHash, target.global_hash);

        const tags = query.getInheritedTagNames(target.node_id);
        assert.ok(!tags.includes('exam2026'), 'removed card should lose the deck tag');
        assert.ok(tags.includes('sourcedoc'), 'removed card should keep its document tag');
        console.log('  Removed card lost "exam2026", kept "sourcedoc"');
    });

    it('deleting the deck removes the deck tag from remaining cards and prunes it', async () => {
        await decks.deleteDeck(deckHash);

        for (const c of cardRows.slice(1)) {
            assert.ok(!query.getInheritedTagNames(c.node_id).includes('exam2026'),
                'deleting the deck should clear its inherited tag from cards');
        }
        assert.ok(!query.getAllTags().includes('exam2026'),
            '"exam2026" should be pruned once its only deck is gone');
        console.log('  Deck deletion cleared and pruned "exam2026"');
    });
});

// ── Performance ───────────────────────────────────────────────────────────────

describe('Tag propagation — performance', () => {
    // Scale: 5 folders × 20 docs × 50 cards × 5 tags = 25,000 InheritedTags entries
    const FOLDERS   = 5;
    const DOCS_PER  = 20;
    const CARDS_PER = 50;
    const TAGS      = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const ROOT      = 'TagPerfWorkspace';

    before(async () => {
        rmWorkspace(ROOT);
        await sealTools.init();
        await docs.createFolder(ROOT);

        const totalCards = FOLDERS * DOCS_PER * CARDS_PER;
        const expectedInherited = totalCards * TAGS.length;
        console.log(`  Seeding ${FOLDERS} folders × ${DOCS_PER} docs × ${CARDS_PER} cards × ${TAGS.length} tags` +
            ` = ${totalCards} flashcards, ~${expectedInherited} InheritedTags entries…`);

        const t0 = performance.now();
        for (let f = 0; f < FOLDERS; f++) {
            const folderName = `Folder${f}`;
            await docs.createFolder(folderName, ROOT);
            const folderPath = path.join(ROOT, folderName);

            for (let d = 0; d < DOCS_PER; d++) {
                await docs.importFile(`doc${d}.md`, folderPath, Buffer.from(`# Doc ${d}`), {
                    globalHash: crypto.randomUUID(),
                    flashcards: makeCards(CARDS_PER),
                });
            }

            await docs.updateMetadata(folderPath, { tags: TAGS }, true);
        }

        console.log(`  Seeded in ${(performance.now() - t0).toFixed(0)}ms`);
    });

    after(async () => {
        rmWorkspace(ROOT);
        db.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true });
        } catch (e) {
            console.warn('Teardown warning (safe to ignore): Failed to delete data directory:', e.message);
        }
    });

    it('getGraphData stays under 500ms with ~25k inherited tag edges', () => {
        const t0 = performance.now();
        const { nodes, edges } = query.getGraphData();
        const ms = performance.now() - t0;

        const fcNodes = new Set(nodes.filter(n => n.type === 'Flashcard').map(n => n.id));
        const inheritedTagEdges = edges.filter(e => e.relation === 'tag' && fcNodes.has(e.fromId));

        console.log(
            `  getGraphData: ${nodes.length} nodes, ${edges.length} total edges,` +
            ` ${inheritedTagEdges.length} flashcard→tag edges — ${ms.toFixed(1)}ms`
        );
        assert.ok(ms < 500, `getGraphData took ${ms.toFixed(0)}ms — should be under 500ms`);
    });

    it('superSearch tag:alpha stays under 100ms across ~25k inherited tag edges', () => {
        const t0 = performance.now();
        const results = query.superSearch({ tag: 'alpha', limit: 200 });
        const ms = performance.now() - t0;

        console.log(`  superSearch tag:alpha → ${results.flashcards.length} results in ${ms.toFixed(1)}ms`);
        assert.ok(ms < 100, `superSearch took ${ms.toFixed(0)}ms — should be under 100ms`);
        assert.ok(results.flashcards.length > 0, 'Should find flashcards tagged alpha');
    });

    it('broad tag search (tag:a matches all 5 tags) stays under 200ms', () => {
        const t0 = performance.now();
        const results = query.superSearch({ tag: 'a', limit: 500 });
        const ms = performance.now() - t0;

        console.log(`  superSearch tag:a (broad) → ${results.flashcards.length} results in ${ms.toFixed(1)}ms`);
        assert.ok(ms < 200, `Broad tag search took ${ms.toFixed(0)}ms — should be under 200ms`);
    });
});
