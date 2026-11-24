import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { testDataDir } from '../support/testData.js';

process.env.USER_DATA_PATH = testDataDir('highlights');
fs.rmSync(process.env.USER_DATA_PATH, { recursive: true, force: true });

const { default: validate } = await import('../../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const Documents = await import('../../src/api/access/modules/documents.js');
const Highlights = await import('../../src/api/access/modules/highlights.js');
const highlightRows = await import('../../src/api/access/resources/db/highlights.js');
const documentRows = await import('../../src/api/access/resources/db/documents.js');
const { sealTools, sealEmitter } = await import('../../src/api/seal/seal.js');
const { default: db } = await import('../../src/api/access/primitives/database.js');
const { getWorkspacePath } = await import('../../src/api/access/primitives/config.js');

const FOLDER = 'HighlightTests';
const DOC = path.join(FOLDER, 'cell.md');
const BODY = 'The mitochondria is the powerhouse of the cell.';
const sidecarFile = (rel) => path.join(getWorkspacePath(), `${rel}.flashback`);
const readSidecar = (rel) => JSON.parse(fs.readFileSync(sidecarFile(rel), 'utf-8'));
const writeSidecar = (rel, data) => fs.writeFileSync(sidecarFile(rel), JSON.stringify(data, null, 2));

after(async () => {
    await sealEmitter.quiesce();
    db.close();
});

describe('highlights', () => {
    before(async () => {
        await sealTools.init();
        await Documents.createFolder(FOLDER);
        await Documents.importFile('cell.md', FOLDER, Buffer.from(BODY), { globalHash: crypto.randomUUID() });
    });

    it('writes a new highlight to the sidecar and to the index', async () => {
        const h = await Highlights.createHighlight(DOC, { start: 4, end: 16, color: 'green' });
        assert.ok(readSidecar(DOC).highlights.some((x) => x.id === h.id));
        const doc = await documentRows.getByPath(DOC);
        assert.ok((await highlightRows.getByDocumentId(doc.id)).some((r) => r.global_hash === h.id));
    });

    it('lists highlights with their text and context, filtered by color and by cards', async () => {
        await Highlights.createHighlight(DOC, { text: 'powerhouse', color: 'amber' });
        const green = await Highlights.listAnnotated({ path: DOC, color: 'green' });
        assert.equal(green.length, 1);
        assert.equal(green[0].text, 'mitochondria');
        assert.equal(green[0].context, BODY);
        const uncarded = await Highlights.listAnnotated({ path: DOC, uncardedOnly: true });
        assert.equal(uncarded.length, 2, 'neither highlight has a card yet');
    });

    it('updates and deletes a highlight in both places', async () => {
        const [first] = Highlights.getHighlights(DOC);
        await Highlights.updateHighlight(DOC, first.id, { note: 'remember this' });
        assert.equal(Highlights.getHighlights(DOC).find((h) => h.id === first.id).note, 'remember this');

        await Highlights.deleteHighlight(DOC, first.id);
        assert.ok(!Highlights.getHighlights(DOC).some((h) => h.id === first.id));
        const doc = await documentRows.getByPath(DOC);
        assert.ok(!(await highlightRows.getByDocumentId(doc.id)).some((r) => r.global_hash === first.id));
    });
});

describe('a sidecar with fields of the wrong type', () => {
    const BAD = path.join(FOLDER, 'bad.md');

    before(async () => {
        await Documents.importFile('bad.md', FOLDER, Buffer.from('# bad'), { globalHash: crypto.randomUUID() });
        writeSidecar(BAD, { ...readSidecar(BAD), highlights: 'oops', flashcards: 5 });
    });

    it('reads as no highlights instead of crashing or splitting a string', async () => {
        assert.deepEqual(Highlights.getHighlights(BAD), []);
        assert.deepEqual(await Highlights.listAnnotated({ path: BAD }), []);
    });

    it('replaces a broken highlights field when a highlight is added', async () => {
        const h = await Highlights.createHighlight(BAD, { text: 'bad', color: 'amber' });
        assert.deepEqual(readSidecar(BAD).highlights.map((x) => x.id), [h.id]);
    });

    it('refuses to reindex a flashcards field that is not a list, so no card leaves the index', async () => {
        writeSidecar(BAD, { ...readSidecar(BAD), flashcards: 5 });
        await assert.rejects(() => Documents.reindexDocument(BAD), { code: 'malformed_sidecar' });
    });

    it('skips card entries that are not objects with a hash', async () => {
        const good = crypto.randomUUID();
        writeSidecar(BAD, {
            ...readSidecar(BAD),
            flashcards: [null, 'text', { vanillaData: {} }, { globalHash: good, vanillaData: { frontText: 'Q', backText: 'A' } }],
        });
        await Documents.reindexDocument(BAD);
        const doc = await documentRows.getByPath(BAD);
        const rows = await db.prepare('SELECT global_hash FROM Flashcards WHERE document_id = ?').all(doc.id);
        assert.deepEqual(rows.map((r) => r.global_hash), [good]);
    });
});
