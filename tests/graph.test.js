import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import Documents from '../src/api/access/orchestration/documents.js';
import db from '../src/api/access/primitives/database.js';
import fs from 'fs';
import validate from '../src/api/config/validate.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/primitives/config.js';
import { aggregateMass, haloRadius, HALO_BASE, HALO_MAX } from '../src/ui/views/graphMetrics.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const ROOT = 'GraphTestWorkspace';

const getInheritanceEdges = async () =>
    await db.prepare(`
        SELECT c.origin_id as fromNode, c.destiny_id as toNode
        FROM Connections c
        JOIN ConnectionTypes ct ON c.type_id = ct.id
        WHERE ct.name = 'inheritance'
    `).all();

const hasEdge = (edges, fromNode, toNode) =>
    edges.some(e => e.fromNode === fromNode && e.toNode === toNode);

const folderNodeId = async (relPath) =>
    (await db.prepare('SELECT node_id FROM Folders WHERE relative_path = ?').get(relPath))?.node_id;

const docNodeId = async (relPath) =>
    (await db.prepare('SELECT node_id FROM Documents WHERE relative_path = ?').get(relPath))?.node_id;

/**
 * Creates a document holding one card per entry in `levels`, each stamped at that
 * Leitner level. Levels map through CARD_LEARNED_SQL: 0 → 0, 3 → 0.5, 6 → 1.0.
 */
const addCards = async (docRel, name, folderRel, levels) => {
    await docs.createFile(name, folderRel);
    for (const [i, level] of levels.entries()) {
        const saved = await docs.createFlashcard(docRel, {
            cardType: 'basic',
            vanillaData: { frontText: `${name}-Q${i}`, backText: `${name}-A${i}` },
        });
        await db.prepare('UPDATE Flashcards SET level = ? WHERE global_hash = ?').run(level, saved.globalHash);
    }
};

describe('Graph hierarchy — inheritance edges', () => {

    before(async () => {
        const absRoot = path.join(getWorkspacePath(), ROOT);
        if (fs.existsSync(absRoot)) fs.rmSync(absRoot, { recursive: true, force: true });
        await sealTools.init();
        await docs.createFolder(ROOT);
    });

    after(async () => {
        db.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        try {
            fs.rmSync(path.join(process.cwd(), 'data'), { recursive: true, force: true });
        } catch (e) {
            console.warn('Teardown warning (safe to ignore): Failed to delete data directory:', e.message);
        }
    });

    it('creating a file in a folder adds an inheritance edge folder→file', async () => {
        await docs.createFolder('Animals', ROOT);
        await docs.createFile('dog', path.join(ROOT, 'Animals'));

        const edges = await getInheritanceEdges();
        const parentNode = await folderNodeId(path.join(ROOT, 'Animals'));
        const childNode  = await docNodeId(path.join(ROOT, 'Animals', 'dog.md'));

        assert.ok(parentNode, 'Animals folder node exists');
        assert.ok(childNode,  'dog.md document node exists');
        assert.ok(hasEdge(edges, parentNode, childNode), 'inheritance edge Animals→dog.md exists');
    });

    it('creating a subfolder adds an inheritance edge parent→subfolder', async () => {
        await docs.createFolder('Mammals', path.join(ROOT, 'Animals'));

        const edges = await getInheritanceEdges();
        const parentNode = await folderNodeId(path.join(ROOT, 'Animals'));
        const childNode  = await folderNodeId(path.join(ROOT, 'Animals', 'Mammals'));

        assert.ok(parentNode, 'Animals folder node exists');
        assert.ok(childNode,  'Mammals folder node exists');
        assert.ok(hasEdge(edges, parentNode, childNode), 'inheritance edge Animals→Mammals exists');
    });

    it('moving a file updates the inheritance edge to the new parent', async () => {
        await docs.createFolder('Plants', ROOT);
        await docs.createFile('rose', path.join(ROOT, 'Plants'));

        const roseNode    = await docNodeId(path.join(ROOT, 'Plants', 'rose.md'));
        const plantsNode  = await folderNodeId(path.join(ROOT, 'Plants'));
        const animalsNode = await folderNodeId(path.join(ROOT, 'Animals'));

        assert.ok(hasEdge(await getInheritanceEdges(), plantsNode, roseNode), 'edge Plants→rose exists before move');

        await docs.move(
            path.join(ROOT, 'Plants', 'rose.md'),
            path.join(ROOT, 'Animals', 'rose.md'),
            false
        );

        const edgesAfter = await getInheritanceEdges();
        assert.ok(!hasEdge(edgesAfter, plantsNode, roseNode),  'old edge Plants→rose removed');
        assert.ok(hasEdge(edgesAfter, animalsNode, roseNode),  'new edge Animals→rose added');
    });

    it('moving a folder updates its inheritance edge to the new parent', async () => {
        await docs.createFolder('Oceans', ROOT);
        await docs.createFolder('Pacific', path.join(ROOT, 'Oceans'));

        const pacificNode = await folderNodeId(path.join(ROOT, 'Oceans', 'Pacific'));
        const oceansNode  = await folderNodeId(path.join(ROOT, 'Oceans'));
        const animalsNode = await folderNodeId(path.join(ROOT, 'Animals'));

        assert.ok(hasEdge(await getInheritanceEdges(), oceansNode, pacificNode), 'edge Oceans→Pacific exists before move');

        await docs.move(
            path.join(ROOT, 'Oceans', 'Pacific'),
            path.join(ROOT, 'Animals', 'Pacific'),
            true
        );

        const edgesAfter = await getInheritanceEdges();
        assert.ok(!hasEdge(edgesAfter, oceansNode, pacificNode),  'old edge Oceans→Pacific removed');
        assert.ok(hasEdge(edgesAfter, animalsNode, pacificNode),  'new edge Animals→Pacific added');
    });

    it('getGraphData includes inheritance edges', async () => {
        const { edges } = await docs.query.getGraphData();
        const inheritanceEdges = edges.filter(e => e.relation === 'inheritance');
        assert.ok(inheritanceEdges.length > 0, 'getGraphData returns at least one inheritance edge');
    });

    it('graph nodes carry a learned scalar and a card count', async () => {
        const studiedRel = path.join(ROOT, 'Animals', 'studied.md');
        const emptyRel   = path.join(ROOT, 'Animals', 'empty.md');
        await docs.createFile('studied', path.join(ROOT, 'Animals'));
        await docs.createFile('empty',   path.join(ROOT, 'Animals'));

        // Two cards at level 3 and one still new: 0.5 + 0.5 + 0 over 3 cards.
        for (const [i, level] of [3, 3, 0].entries()) {
            const saved = await docs.createFlashcard(studiedRel, {
                cardType: 'basic',
                vanillaData: { frontText: `Q${i}`, backText: `A${i}` },
            });
            await db.prepare('UPDATE Flashcards SET level = ? WHERE global_hash = ?').run(level, saved.globalHash);
        }

        const byId = new Map((await await docs.getGraphData()).nodes.map(n => [n.id, n]));
        const studied = byId.get(await docNodeId(studiedRel));
        const empty   = byId.get(await docNodeId(emptyRel));

        assert.equal(studied.cardCount, 3, 'studied document reports its three cards');
        assert.ok(studied.learned > 0 && studied.learned < 1,
            `partially studied document scores strictly between 0 and 1 (got ${studied.learned})`);
        assert.ok(Math.abs(studied.learned - 1 / 3) < 1e-6,
            `learned is the mean per-card score (got ${studied.learned})`);

        // mass is the *absolute* amount: 0.5 + 0.5 + 0. learned is that over three
        // cards. The pair is what tells "a little, well known" apart from "a lot,
        // half known" — learned alone reports the same number for both.
        assert.ok(Math.abs(studied.mass - 1.0) < 1e-6,
            `mass is the summed per-card score, not the mean (got ${studied.mass})`);

        // A card-less document must be distinguishable from an unstudied one.
        assert.equal(empty.cardCount, 0, 'card-less document reports zero cards');
        assert.equal(empty.learned, 0, 'card-less document scores 0');
        assert.equal(empty.mass, 0, 'card-less document carries no mass');

        // Flashcard nodes used to always read 0 because Flashcards.presence is
        // hardcoded at insert; they now carry their own strength.
        const cardNodes = [...byId.values()].filter(n => n.type === 'Flashcard' && n.flashcardDocPath === studiedRel);
        assert.equal(cardNodes.length, 3, 'all three card nodes are in the graph');
        assert.ok(cardNodes.some(n => n.learned > 0), 'a level-3 card node scores above 0');
        assert.ok(cardNodes.some(n => n.learned === 0), 'a brand-new card node scores 0');

        // Nothing should leak the intermediate SQL columns. `mass` is the public
        // name for what learnedSum holds, so learnedSum itself must still go.
        assert.ok(!('learnedSum' in studied) && !('flashcardLearned' in studied),
            'intermediate rollup columns are stripped from the payload');
        assert.ok(!('folderLearnedSum' in studied) && !('folderCardCount' in studied),
            'folder rollup columns are stripped from the payload');
    });

    it('a folder rolls up the cards of its whole subtree', async () => {
        const rollupRel = path.join(ROOT, 'Rollup');
        const deepRel   = path.join(rollupRel, 'Deep');
        await docs.createFolder('Rollup', ROOT);
        await docs.createFolder('Deep', rollupRel);

        await addCards(path.join(rollupRel, 'shallow.md'), 'shallow', rollupRel, [6, 6]);
        await addCards(path.join(deepRel, 'deep.md'),      'deep',    deepRel,   [3, 3, 3, 3]);

        const byId = new Map((await await docs.getGraphData()).nodes.map(n => [n.id, n]));
        const rollup = byId.get(await folderNodeId(rollupRel));
        const deep   = byId.get(await folderNodeId(deepRel));

        // Deep holds only its own four half-learned cards.
        assert.equal(deep.cardCount, 4, 'Deep counts its own four cards');
        assert.ok(Math.abs(deep.mass - 2.0) < 1e-6, `Deep mass is 4 x 0.5 (got ${deep.mass})`);

        // Rollup holds those plus its own two, recursively.
        assert.equal(rollup.cardCount, 6, 'Rollup counts its whole subtree');
        assert.ok(Math.abs(rollup.mass - 4.0) < 1e-6,
            `Rollup mass is 2 x 1.0 + 4 x 0.5 (got ${rollup.mass})`);

        // A parent's halo must envelop its children's — the property the old
        // hardcoded per-type HALO_SCALE was standing in for.
        assert.ok(rollup.mass >= deep.mass, 'parent mass is at least its child\'s');
        assert.ok(haloRadius(rollup.mass) > haloRadius(deep.mass),
            'parent halo is strictly wider than the child it contains');
    });

    it('a folder\'s learned rate is card-weighted, not an average of documents', async () => {
        const weightedRel = path.join(ROOT, 'Weighted');
        await docs.createFolder('Weighted', ROOT);

        // One small perfect document and one large mediocre one. Averaging the two
        // documents' rates gives 0.75; weighting by cards gives 7/12 = 0.583. The
        // old presence/6 path took the unweighted route, which is exactly how a
        // two-card document came to outrank a large one.
        await addCards(path.join(weightedRel, 'tiny.md'), 'tiny', weightedRel, [6, 6]);
        await addCards(path.join(weightedRel, 'big.md'),  'big',  weightedRel,
            Array(10).fill(3));

        const byId = new Map((await await docs.getGraphData()).nodes.map(n => [n.id, n]));
        const weighted = byId.get(await folderNodeId(weightedRel));

        assert.equal(weighted.cardCount, 12, 'folder counts all twelve cards');
        assert.ok(Math.abs(weighted.learned - 7 / 12) < 1e-6,
            `folder rate is card-weighted (got ${weighted.learned}, unweighted would be 0.75)`);
        assert.ok(weighted.learned < 0.75,
            'the ten-card document dominates, as it should');
    });

    it('tag mass sums its documents without double-counting inherited members', async () => {
        const taggedRel = path.join(ROOT, 'Tagged');
        await docs.createFolder('Tagged', ROOT);
        await addCards(path.join(taggedRel, 'td.md'), 'td', taggedRel, [6, 6]);

        // Tagging the FOLDER propagates the tag down to its documents and on to
        // their flashcards (documents.js _propagateFolderTags), so the tag's
        // endpoint set contains the same two cards three times over: once as the
        // folder, once as the document, once as the cards themselves.
        const meta = docs.files.getMetadata(taggedRel, true) || {};
        await docs.updateMetadata(taggedRel, { ...meta, tags: ['physics'] }, true);

        const { nodes, edges } = await docs.getGraphData();
        const tagNode = nodes.find(n => n.type === 'Tag' && n.label === 'physics');
        assert.ok(tagNode, 'the physics tag is a graph node');

        // The premise the dedup guard rests on: the tag really does reach the
        // document, not just the folder.
        // Resolved before the search: docNodeId reads the database, so it cannot run
        // inside a .find() predicate now that the data layer is async.
        const wantedDocNodeId = await docNodeId(path.join(taggedRel, 'td.md'));
        const docNode = nodes.find(n => n.id === wantedDocNodeId);
        const reachesDoc = edges.some(e =>
            e.relation === 'tag' &&
            ((e.fromId === docNode.id && e.toId === tagNode.id) ||
             (e.toId === docNode.id && e.fromId === tagNode.id)));
        assert.ok(reachesDoc, 'a folder tag propagates to its descendant documents');

        const agg = aggregateMass(nodes, edges).get(tagNode.id);
        assert.ok(agg, 'the tag gets an aggregate');
        assert.equal(agg.cardCount, 2, `tag counts each card once (got ${agg.cardCount})`);
        assert.ok(Math.abs(agg.mass - 2.0) < 1e-6,
            `tag mass counts each card once (got ${agg.mass}, triple-counting would give 6)`);
    });

    it('haloRadius grows with the square root of mass and clamps', () => {
        // Pinned so the visual weighting can't drift silently. √ because the halo
        // is a disc: lit AREA is what should track knowledge held.
        for (const [mass, expected] of [[1, 15], [4, 19], [20, 28.8885], [80, 46.7771], [300, 80.2820]]) {
            assert.ok(Math.abs(haloRadius(mass) - expected) < 0.01,
                `mass ${mass} → ${expected}px (got ${haloRadius(mass)})`);
        }

        assert.equal(haloRadius(0), HALO_BASE, 'zero mass sits at the base radius');
        assert.equal(haloRadius(-5), HALO_BASE, 'negative mass degrades to the base radius');
        assert.equal(haloRadius(undefined), HALO_BASE, 'a node without mass still draws');
        assert.equal(haloRadius(1e9), HALO_MAX, 'a huge vault clamps rather than leaving the screen');

        // The regression this whole change exists to prevent: a small perfectly
        // known document must NOT out-glow a large half-known one.
        const twoPerfectCards = haloRadius(2);        // 80 cards @ 0.5 = mass 40
        const eightyHalfCards = haloRadius(40);
        assert.ok(eightyHalfCards > twoPerfectCards * 2,
            `the larger knowledge area glows wider (${eightyHalfCards} vs ${twoPerfectCards})`);
    });
});
