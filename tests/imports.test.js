import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import validate from '../src/api/config/validate.js';
import db from '../src/api/access/Database.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/Config.js';
import AnkiImport from '../src/api/access/ankiImport.js';
import ObsidianImport from '../src/api/access/obsidianImport.js';
import BetterSQLite from 'better-sqlite3';
import AdmZip from 'adm-zip';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data_test_imports');

if (!validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

/** Build a minimal legacy-format Anki SQLite DB in memory, write to disk, and return the path. */
function buildAnkiDb(filePath, { decks, models, notes, cards }) {
    const ankiDb = new BetterSQLite(filePath);
    ankiDb.exec(`
        CREATE TABLE col (id INTEGER PRIMARY KEY, decks TEXT, models TEXT);
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY, guid TEXT, mid INTEGER, mod INTEGER,
            usn INTEGER, tags TEXT, flds TEXT, sfld TEXT, csum INTEGER,
            flags INTEGER, data TEXT
        );
        CREATE TABLE cards (
            id INTEGER PRIMARY KEY, nid INTEGER, did INTEGER, ord INTEGER,
            mod INTEGER, usn INTEGER, type INTEGER, queue INTEGER, due INTEGER,
            ivl INTEGER, factor INTEGER, reps INTEGER, lapses INTEGER, left INTEGER,
            odue INTEGER, odid INTEGER, flags INTEGER, data TEXT
        );
    `);
    ankiDb.prepare("INSERT INTO col (id, decks, models) VALUES (1, ?, ?)").run(
        JSON.stringify(decks), JSON.stringify(models)
    );
    const noteStmt = ankiDb.prepare("INSERT INTO notes (id, guid, mid, tags, flds) VALUES (?, ?, ?, ?, ?)");
    for (const n of notes) noteStmt.run(n.id, n.guid, n.mid, n.tags ?? '', n.flds);
    const cardStmt = ankiDb.prepare("INSERT INTO cards (id, nid, did, ord, factor, reps) VALUES (?, ?, ?, ?, ?, ?)");
    for (const c of cards) cardStmt.run(c.id, c.nid, c.did, c.ord, c.factor ?? 2500, c.reps ?? 0);
    ankiDb.close();
}

/** Pack a DB file (and optional media) into an in-memory .apkg ZIP buffer. */
function buildApkg(dbPath, dbName = 'collection.anki21', extraFiles = {}) {
    const zip = new AdmZip();
    zip.addLocalFile(dbPath, '', dbName);
    zip.addFile('media', Buffer.from(JSON.stringify(extraFiles.mediaMap ?? {})));
    return zip.toBuffer();
}

describe('Importers Integration Tests', () => {
    before(async () => {
        const gitDir = path.join(getWorkspacePath(), '.git');
        if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
        await sealTools.init();
    });

    after(async () => {
        db.close();
        await new Promise(resolve => setTimeout(resolve, 50));
        try { fs.rmSync(process.env.USER_DATA_PATH, { recursive: true, force: true }); } catch (e) {}
    });

    it('should import a basic Anki card with media', async () => {
        const dbPath = path.join(process.cwd(), `temp_anki_basic_${Date.now()}.db`);
        const pngPath = path.join(process.cwd(), `temp_hola_${Date.now()}.png`);
        fs.writeFileSync(pngPath, 'mock_png_data');

        buildAnkiDb(dbPath, {
            decks: { 123: { id: 123, name: 'Spanish::Vocabulary' } },
            models: {
                456: {
                    id: 456, name: 'Basic-Model', type: 0,
                    flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
                    tmpls: [{ ord: 0, name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n{{Back}}' }],
                },
            },
            notes: [{ id: 1001, guid: 'guid1', mid: 456, flds: 'Hola <img src="hola.png">\x1fHello' }],
            cards: [{ id: 2001, nid: 1001, did: 123, ord: 0, factor: 2500, reps: 5 }],
        });

        const zip = new AdmZip();
        zip.addLocalFile(dbPath, '', 'collection.anki21');
        zip.addLocalFile(pngPath, '', '0');
        zip.addFile('media', Buffer.from(JSON.stringify({ '0': 'hola.png' })));
        const zipBuffer = zip.toBuffer();

        fs.unlinkSync(dbPath);
        fs.unlinkSync(pngPath);

        const importer = new AnkiImport();
        const result = await importer.importApkg(zipBuffer, '');
        assert.ok(result.ok);
        assert.ok(result.path.includes('Anki_Import_'));

        const deck = importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('Spanish_Vocabulary');
        assert.ok(deck, 'Deck should exist');

        const entries = importer.query.getDeckEntries(deck.id);
        assert.equal(entries.length, 1, 'One card per note');
        assert.equal(entries[0].card_type, 'basic');
        assert.equal(entries[0].level, 1); // reps=5 → floor(5/3)=1

        const srsState = importer.query.getAllFlashcardSrsState()
            .find(s => s.global_hash === entries[0].card_hash);
        assert.ok(srsState);
        assert.equal(srsState.level, 1);
        assert.equal(importer.query.getLatestEaseFactors().get(entries[0].card_hash), 2.5);

        const media = importer.query.db.prepare("SELECT * FROM Media").all();
        assert.ok(media.length >= 1, 'Media should be registered');
    });

    it('should create one reversible card per Basic+Reversed note (not two basic cards)', async () => {
        const dbPath = path.join(process.cwd(), `temp_anki_rev_${Date.now()}.db`);

        buildAnkiDb(dbPath, {
            decks: { 200: { id: 200, name: 'Geography' } },
            models: {
                700: {
                    id: 700, name: 'Basic (and reversed card)', type: 0,
                    flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
                    tmpls: [
                        { ord: 0, name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}\n\n{{Back}}' },
                        { ord: 1, name: 'Card 2', qfmt: '{{Back}}',  afmt: '{{FrontSide}}\n\n{{Front}}' },
                    ],
                },
            },
            notes: [{ id: 3001, guid: 'guid3', mid: 700, flds: 'Capital of France?\x1fParis' }],
            // Anki emits two cards for one Basic+Reversed note
            cards: [
                { id: 4001, nid: 3001, did: 200, ord: 0, reps: 3 },
                { id: 4002, nid: 3001, did: 200, ord: 1, reps: 1 },
            ],
        });

        const zipBuffer = buildApkg(dbPath);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        const result = await importer.importApkg(zipBuffer, '');
        assert.ok(result.ok);

        const deck = importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('Geography');
        assert.ok(deck, 'Deck should exist');

        const entries = importer.query.getDeckEntries(deck.id);
        assert.equal(entries.length, 1, 'One Flashback card per note, not one per Anki card');
        assert.equal(entries[0].card_type, 'reversible');
        assert.equal(entries[0].frontText, 'Capital of France?');
        assert.equal(entries[0].backText, 'Paris');
    });

    it('should create a type_answer card and extract front/back from template', async () => {
        const dbPath = path.join(process.cwd(), `temp_anki_type_${Date.now()}.db`);

        buildAnkiDb(dbPath, {
            decks: { 300: { id: 300, name: 'TypeAnswer_Deck' } },
            models: {
                800: {
                    id: 800, name: 'Basic (type in the answer)', type: 0,
                    flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
                    tmpls: [
                        { ord: 0, name: 'Card 1', qfmt: '{{Front}}\n\n{{type:Back}}', afmt: '{{FrontSide}}\n\n{{Back}}' },
                    ],
                },
            },
            notes: [{ id: 5001, guid: 'guid5', mid: 800, flds: 'Capital of Germany?\x1fBerlin' }],
            cards: [{ id: 6001, nid: 5001, did: 300, ord: 0, reps: 0 }],
        });

        const zipBuffer = buildApkg(dbPath);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        const result = await importer.importApkg(zipBuffer, '');
        assert.ok(result.ok);

        const deck = importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('TypeAnswer_Deck');
        assert.ok(deck, 'Deck should exist');

        const entries = importer.query.getDeckEntries(deck.id);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].card_type, 'type_answer');
        assert.equal(entries[0].frontText, 'Capital of Germany?');
        assert.equal(entries[0].backText, 'Berlin');
    });

    it('should create one cloze card per note (not one per cloze deletion)', async () => {
        const dbPath = path.join(process.cwd(), `temp_anki_cloze_${Date.now()}.db`);

        buildAnkiDb(dbPath, {
            decks: { 400: { id: 400, name: 'Biology_Cloze' } },
            models: {
                900: {
                    id: 900, name: 'Cloze', type: 1,
                    flds: [{ name: 'Text', ord: 0 }, { name: 'Back Extra', ord: 1 }],
                    tmpls: [{ ord: 0, name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Back Extra}}' }],
                },
            },
            notes: [{ id: 7001, guid: 'guid7', mid: 900, flds: 'The {{c1::mitochondria}} is the {{c2::powerhouse}} of the cell.\x1f' }],
            // Anki generates one card per cloze deletion (c1 and c2 → 2 cards)
            cards: [
                { id: 8001, nid: 7001, did: 400, ord: 0, reps: 4 },
                { id: 8002, nid: 7001, did: 400, ord: 1, reps: 2 },
            ],
        });

        const zipBuffer = buildApkg(dbPath);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        const result = await importer.importApkg(zipBuffer, '');
        assert.ok(result.ok);

        const deck = importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('Biology_Cloze');
        assert.ok(deck, 'Deck should exist');

        const entries = importer.query.getDeckEntries(deck.id);
        assert.equal(entries.length, 1, 'One Flashback cloze card per note, not per cloze deletion');
        assert.equal(entries[0].card_type, 'cloze');
        // Anki syntax stripped to Flashback cloze syntax
        assert.ok(entries[0].frontText.includes('{{mitochondria}}'));
        assert.ok(entries[0].frontText.includes('{{powerhouse}}'));
    });

    it('should extract real cloze content when the qfmt template wraps {{cloze:Text}} in extra markup', async () => {
        // Reproduces third-party Anki add-ons (e.g. code-highlighter plugins) that inject
        // <link>/<script> tags around the cloze placeholder in every card template.
        // Regression: the field-substitution regex used to treat "cloze:Text" as a literal
        // field name (only "type:" was special-cased), so {{cloze:Text}} resolved to '' and
        // the real cloze markup was silently dropped, leaving only the injected HTML noise.
        const dbPath = path.join(process.cwd(), `temp_anki_cloze_wrapped_${Date.now()}.db`);

        buildAnkiDb(dbPath, {
            decks: { 401: { id: 401, name: 'Wrapped_Cloze' } },
            models: {
                901: {
                    id: 901, name: 'Cloze', type: 1,
                    flds: [{ name: 'Text', ord: 0 }, { name: 'Back Extra', ord: 1 }],
                    tmpls: [{
                        ord: 0, name: 'Cloze',
                        qfmt: '{{cloze:Text}}\n\n<!-- Addon BEGIN -->\n<link rel="stylesheet" href="x.css">\n<script src="y.js"></script>\n<!-- Addon END -->',
                        afmt: '{{cloze:Text}}<br>{{Back Extra}}',
                    }],
                },
            },
            notes: [{ id: 7002, guid: 'guid8', mid: 901, flds: 'The {{c1::mitochondria}} is the powerhouse.\x1f' }],
            cards: [{ id: 8003, nid: 7002, did: 401, ord: 0, reps: 1 }],
        });

        const zipBuffer = buildApkg(dbPath);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        const result = await importer.importApkg(zipBuffer, '');
        assert.ok(result.ok);

        const deck = importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('Wrapped_Cloze');
        assert.ok(deck, 'Deck should exist');

        const entries = importer.query.getDeckEntries(deck.id);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].card_type, 'cloze');
        assert.ok(entries[0].frontText.includes('{{mitochondria}}'), 'Real cloze content must survive, not just the addon markup');
        assert.ok(!/anki code highlighter/i.test(entries[0].frontText), 'Injected addon markup should not leak into card text');
    });

    it('should import Obsidian vaults correctly', async () => {
        const zip = new AdmZip();

        const noteAContent = `---
tags:
  - science
  - bio
---
# Mitochondria
This is [[Mitochondria#Structure|Mitochondria Structure]] and a link to [[Cell Membrane]].
What is the powerhouse? :: Mitochondria
The {{mitochondria}} is the powerhouse of the cell.
And a multiline card:
Question #card
Answer
`;
        zip.addFile('Mitochondria.md', Buffer.from(noteAContent));

        const noteBContent = `# Cell Membrane
This is the boundary. ![[boundary.png]]
`;
        zip.addFile('Cell Membrane.md', Buffer.from(noteBContent));
        zip.addFile('boundary.png', Buffer.from('mock_image_bytes'));

        const zipBuffer = zip.toBuffer();

        const importer = new ObsidianImport();
        const result = await importer.importVault(zipBuffer, '');
        assert.ok(result.ok);

        const docA = importer.documents.query.getDocumentByPath(path.join(result.path, 'Mitochondria.md'));
        const docB = importer.documents.query.getDocumentByPath(path.join(result.path, 'Cell Membrane.md'));
        assert.ok(docA, 'Mitochondria.md should be imported');
        assert.ok(docB, 'Cell Membrane.md should be imported');

        const contentA = importer.files.readFile(path.join(result.path, 'Mitochondria.md')).content;
        assert.ok(contentA.includes('flashback://'), 'Wiki links should be converted to flashback://');

        const cardsA = importer.documents.query.getFlashcardsByDocument(docA.id);
        assert.equal(cardsA.length, 3, 'Mitochondria.md should have 3 flashcards');
        assert.ok(cardsA.some(c => c.card_type === 'basic'));
        assert.ok(cardsA.some(c => c.card_type === 'cloze'));

        const tagsA = importer.documents.query.getDirectTagNames(docA.node_id);
        assert.ok(tagsA.includes('science'));
        assert.ok(tagsA.includes('bio'));
    });
});
