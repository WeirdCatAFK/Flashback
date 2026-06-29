import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import Documents from '../src/api/access/documents.js';
import db from '../src/api/access/database.js';
import fs from 'fs';
import validate from '../src/api/config/validate.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/config.js';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data');

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const docs = new Documents();
const ROOT = 'GraphTestWorkspace';

const getInheritanceEdges = () =>
    db.prepare(`
        SELECT c.origin_id as fromNode, c.destiny_id as toNode
        FROM Connections c
        JOIN ConnectionTypes ct ON c.type_id = ct.id
        WHERE ct.name = 'inheritance'
    `).all();

const hasEdge = (edges, fromNode, toNode) =>
    edges.some(e => e.fromNode === fromNode && e.toNode === toNode);

const folderNodeId = (relPath) =>
    db.prepare('SELECT node_id FROM Folders WHERE relative_path = ?').get(relPath)?.node_id;

const docNodeId = (relPath) =>
    db.prepare('SELECT node_id FROM Documents WHERE relative_path = ?').get(relPath)?.node_id;

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

        const edges = getInheritanceEdges();
        const parentNode = folderNodeId(path.join(ROOT, 'Animals'));
        const childNode  = docNodeId(path.join(ROOT, 'Animals', 'dog.md'));

        assert.ok(parentNode, 'Animals folder node exists');
        assert.ok(childNode,  'dog.md document node exists');
        assert.ok(hasEdge(edges, parentNode, childNode), 'inheritance edge Animals→dog.md exists');
    });

    it('creating a subfolder adds an inheritance edge parent→subfolder', async () => {
        await docs.createFolder('Mammals', path.join(ROOT, 'Animals'));

        const edges = getInheritanceEdges();
        const parentNode = folderNodeId(path.join(ROOT, 'Animals'));
        const childNode  = folderNodeId(path.join(ROOT, 'Animals', 'Mammals'));

        assert.ok(parentNode, 'Animals folder node exists');
        assert.ok(childNode,  'Mammals folder node exists');
        assert.ok(hasEdge(edges, parentNode, childNode), 'inheritance edge Animals→Mammals exists');
    });

    it('moving a file updates the inheritance edge to the new parent', async () => {
        await docs.createFolder('Plants', ROOT);
        await docs.createFile('rose', path.join(ROOT, 'Plants'));

        const roseNode    = docNodeId(path.join(ROOT, 'Plants', 'rose.md'));
        const plantsNode  = folderNodeId(path.join(ROOT, 'Plants'));
        const animalsNode = folderNodeId(path.join(ROOT, 'Animals'));

        assert.ok(hasEdge(getInheritanceEdges(), plantsNode, roseNode), 'edge Plants→rose exists before move');

        await docs.move(
            path.join(ROOT, 'Plants', 'rose.md'),
            path.join(ROOT, 'Animals', 'rose.md'),
            false
        );

        const edgesAfter = getInheritanceEdges();
        assert.ok(!hasEdge(edgesAfter, plantsNode, roseNode),  'old edge Plants→rose removed');
        assert.ok(hasEdge(edgesAfter, animalsNode, roseNode),  'new edge Animals→rose added');
    });

    it('moving a folder updates its inheritance edge to the new parent', async () => {
        await docs.createFolder('Oceans', ROOT);
        await docs.createFolder('Pacific', path.join(ROOT, 'Oceans'));

        const pacificNode = folderNodeId(path.join(ROOT, 'Oceans', 'Pacific'));
        const oceansNode  = folderNodeId(path.join(ROOT, 'Oceans'));
        const animalsNode = folderNodeId(path.join(ROOT, 'Animals'));

        assert.ok(hasEdge(getInheritanceEdges(), oceansNode, pacificNode), 'edge Oceans→Pacific exists before move');

        await docs.move(
            path.join(ROOT, 'Oceans', 'Pacific'),
            path.join(ROOT, 'Animals', 'Pacific'),
            true
        );

        const edgesAfter = getInheritanceEdges();
        assert.ok(!hasEdge(edgesAfter, oceansNode, pacificNode),  'old edge Oceans→Pacific removed');
        assert.ok(hasEdge(edgesAfter, animalsNode, pacificNode),  'new edge Animals→Pacific added');
    });

    it('getGraphData includes inheritance edges', async () => {
        const { nodes, edges } = docs.query.getGraphData();
        const inheritanceEdges = edges.filter(e => e.relation === 'inheritance');
        assert.ok(inheritanceEdges.length > 0, 'getGraphData returns at least one inheritance edge');
    });
});
