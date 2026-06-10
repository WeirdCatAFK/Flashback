import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import process from 'process';
import validate from '../src/api/config/validate.js';
import Documents from '../src/api/access/documents.js';
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

    after(() => {
        rmWorkspace(ROOT);
        db.close();
        fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true });
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
