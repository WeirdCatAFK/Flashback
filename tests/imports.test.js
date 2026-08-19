import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import validate from '../src/api/config/validate.js';
import db from '../src/api/access/primitives/database.js';
import { sealTools } from '../src/api/seal/seal.js';
import { getWorkspacePath } from '../src/api/access/primitives/config.js';
import AnkiImport from '../src/api/access/orchestration/ankiImport.js';
import ObsidianImport from '../src/api/access/orchestration/obsidianImport.js';
import BetterSQLite from 'better-sqlite3';
import AdmZip from 'adm-zip';
import zlib from 'node:zlib';

process.env.USER_DATA_PATH = path.join(process.cwd(), 'data_test_imports');

if (!await validate()) {
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

/* ------------------------------------------------------------------ *
 * Modern (Anki 2.1.50+) package fixtures
 *
 * The default export format since April 2022: schema 15+ tables instead of the
 * `col` JSON blob, notetype/template/field settings as protobuf in a `config`
 * BLOB, and zstd over the collection, the media map, and every media file.
 * ------------------------------------------------------------------ */

function pbVarint(value) {
    const bytes = [];
    let n = BigInt(value);
    do {
        let byte = Number(n & 0x7fn);
        n >>= 7n;
        if (n > 0n) byte |= 0x80;
        bytes.push(byte);
    } while (n > 0n);
    return Buffer.from(bytes);
}
const pbTag = (fieldNo, wire) => pbVarint((fieldNo << 3) | wire);
const pbUint = (fieldNo, value) => Buffer.concat([pbTag(fieldNo, 0), pbVarint(value)]);
const pbBytes = (fieldNo, buf) => Buffer.concat([pbTag(fieldNo, 2), pbVarint(buf.length), buf]);
const pbString = (fieldNo, str) => pbBytes(fieldNo, Buffer.from(str, 'utf-8'));

// proto3 omits fields at their default value on the wire, so the fixtures do too —
// that is what makes `kind` absent for a normal notetype in a real export.
const notetypeConfig = ({ kind = 0, sortf = 0, css = '' }) => Buffer.concat([
    kind ? pbUint(1, kind) : Buffer.alloc(0),
    sortf ? pbUint(2, sortf) : Buffer.alloc(0),
    css ? pbString(3, css) : Buffer.alloc(0),
]);
const templateConfig = (qfmt, afmt) => Buffer.concat([
    qfmt ? pbString(1, qfmt) : Buffer.alloc(0),
    afmt ? pbString(2, afmt) : Buffer.alloc(0),
]);
const fieldConfig = (description = '') =>
    (description ? pbString(5, description) : Buffer.alloc(0));

/** Build a schema-18-shaped Anki collection with protobuf config blobs. */
function buildModernAnkiDb(filePath, { decks, notetypes, notes, cards }) {
    const ankiDb = new BetterSQLite(filePath);
    ankiDb.exec(`
        CREATE TABLE decks (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL, mtime_secs INTEGER NOT NULL,
            usn INTEGER NOT NULL, common BLOB NOT NULL, kind BLOB NOT NULL
        );
        CREATE TABLE notetypes (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL, mtime_secs INTEGER NOT NULL,
            usn INTEGER NOT NULL, config BLOB NOT NULL
        );
        CREATE TABLE fields (
            ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL,
            config BLOB NOT NULL, PRIMARY KEY (ntid, ord)
        );
        CREATE TABLE templates (
            ntid INTEGER NOT NULL, ord INTEGER NOT NULL, name TEXT NOT NULL,
            mtime_secs INTEGER NOT NULL, usn INTEGER NOT NULL, config BLOB NOT NULL,
            PRIMARY KEY (ntid, ord)
        );
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

    const deckStmt = ankiDb.prepare(
        'INSERT INTO decks (id, name, mtime_secs, usn, common, kind) VALUES (?, ?, 0, 0, ?, ?)'
    );
    // Schema 15+ joins nested deck components with \x1f, not "::".
    for (const d of decks) deckStmt.run(d.id, d.name, Buffer.alloc(0), Buffer.alloc(0));

    const ntStmt = ankiDb.prepare(
        'INSERT INTO notetypes (id, name, mtime_secs, usn, config) VALUES (?, ?, 0, 0, ?)'
    );
    const fldStmt = ankiDb.prepare('INSERT INTO fields (ntid, ord, name, config) VALUES (?, ?, ?, ?)');
    const tmplStmt = ankiDb.prepare(
        'INSERT INTO templates (ntid, ord, name, mtime_secs, usn, config) VALUES (?, ?, ?, 0, 0, ?)'
    );
    for (const nt of notetypes) {
        ntStmt.run(nt.id, nt.name, notetypeConfig(nt));
        nt.flds.forEach((f, i) => fldStmt.run(nt.id, i, f.name, fieldConfig(f.description)));
        nt.tmpls.forEach((t, i) => tmplStmt.run(nt.id, i, t.name, templateConfig(t.qfmt, t.afmt)));
    }

    const noteStmt = ankiDb.prepare('INSERT INTO notes (id, guid, mid, tags, flds) VALUES (?, ?, ?, ?, ?)');
    for (const n of notes) noteStmt.run(n.id, n.guid, n.mid, n.tags ?? '', n.flds);
    const cardStmt = ankiDb.prepare('INSERT INTO cards (id, nid, did, ord, factor, reps) VALUES (?, ?, ?, ?, ?, ?)');
    for (const c of cards) cardStmt.run(c.id, c.nid, c.did, c.ord, c.factor ?? 2500, c.reps ?? 0);
    ankiDb.close();
}

/**
 * Pack a modern .apkg: `meta` declaring version 3, a zstd collection, a zstd
 * protobuf media map, and zstd media files.
 * @param {Array<{name: string, data: Buffer}>} media
 */
function buildModernApkg(dbPath, media = []) {
    const zip = new AdmZip();
    zip.addFile('meta', pbUint(1, 3)); // PackageMetadata.version = VERSION_LATEST
    zip.addFile('collection.anki21b', zlib.zstdCompressSync(fs.readFileSync(dbPath)));

    const entries = media.map(m => pbBytes(1, Buffer.concat([
        pbString(1, m.name),
        pbUint(2, m.data.length),
        pbBytes(3, crypto.createHash('sha1').update(m.data).digest()),
    ])));
    zip.addFile('media', zlib.zstdCompressSync(Buffer.concat(entries)));
    media.forEach((m, i) => zip.addFile(String(i), zlib.zstdCompressSync(m.data)));

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

        const deck = await importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('Spanish_Vocabulary');
        assert.ok(deck, 'Deck should exist');

        const entries = await importer.query.getDeckEntries(deck.id, 'owner');
        assert.equal(entries.length, 1, 'One card per note');
        assert.equal(entries[0].card_type, 'basic');
        assert.equal(entries[0].level, 1); // reps=5 → floor(5/3)=1

        const srsState = (await importer.query.getAllFlashcardSrsState('owner'))
            .find(s => s.global_hash === entries[0].card_hash);
        assert.ok(srsState);
        assert.equal(srsState.level, 1);
        assert.equal((await importer.query.getLatestEaseFactors('owner')).get(entries[0].card_hash), 2.5);

        const media = await importer.query.db.prepare("SELECT * FROM Media").all();
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

        const deck = await importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('Geography');
        assert.ok(deck, 'Deck should exist');

        const entries = await importer.query.getDeckEntries(deck.id, 'owner');
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

        const deck = await importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('TypeAnswer_Deck');
        assert.ok(deck, 'Deck should exist');

        const entries = await importer.query.getDeckEntries(deck.id, 'owner');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].card_type, 'type_answer');
        assert.equal(entries[0].frontText, 'Capital of Germany?');
        // The {{type:}} field is what Anki grades, so it becomes the compared answer
        // rather than the back text — which is now free for notes this notetype has none of.
        assert.equal(entries[0].answerText, 'Berlin');
        assert.ok(!entries[0].backText, 'nothing else on the answer side, so no notes');
    });

    // Decks in the Tofugu mould keep their mnemonic in a field of its own. Joining it into
    // the compared answer makes the card impossible to get right; dropping it loses the
    // reason the deck was worth importing. It belongs in the notes.
    it('should map a type_answer notetype\'s extra answer-side field to notes, not the answer', async () => {
        const dbPath = path.join(process.cwd(), `temp_anki_typenotes_${Date.now()}.db`);

        buildAnkiDb(dbPath, {
            decks: { 310: { id: 310, name: 'Kana_Deck' } },
            models: {
                810: {
                    id: 810, name: 'Kana (type in the reading)', type: 0,
                    flds: [{ name: 'Kana', ord: 0 }, { name: 'Reading', ord: 1 }, { name: 'Mnemonic', ord: 2 }],
                    tmpls: [
                        {
                            ord: 0, name: 'Card 1',
                            qfmt: '{{Kana}}\n\n{{type:Reading}}',
                            afmt: '{{FrontSide}}\n\n{{Reading}}<br>{{Mnemonic}}',
                        },
                    ],
                },
            },
            notes: [{ id: 5101, guid: 'guid51', mid: 810, flds: 'か\x1fka\x1fLooks like a kayak.' }],
            cards: [{ id: 6101, nid: 5101, did: 310, ord: 0, reps: 0 }],
        });

        const zipBuffer = buildApkg(dbPath);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        assert.ok((await importer.importApkg(zipBuffer, '')).ok);

        const deck = await importer.query.db.prepare('SELECT * FROM Decks WHERE name = ?').get('Kana_Deck');
        const entry = (await importer.query.getDeckEntries(deck.id, 'owner'))[0];
        assert.equal(entry.card_type, 'type_answer');
        assert.equal(entry.frontText, 'か');
        assert.equal(entry.answerText, 'ka', 'only the {{type:}} field is graded');
        assert.equal(entry.backText, 'Looks like a kayak.', 'the mnemonic survives as notes');
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

        const deck = await importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('Biology_Cloze');
        assert.ok(deck, 'Deck should exist');

        const entries = await importer.query.getDeckEntries(deck.id, 'owner');
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

        const deck = await importer.query.db.prepare("SELECT * FROM Decks WHERE name = ?").get('Wrapped_Cloze');
        assert.ok(deck, 'Deck should exist');

        const entries = await importer.query.getDeckEntries(deck.id, 'owner');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].card_type, 'cloze');
        assert.ok(entries[0].frontText.includes('{{mitochondria}}'), 'Real cloze content must survive, not just the addon markup');
        assert.ok(!/anki code highlighter/i.test(entries[0].frontText), 'Injected addon markup should not leak into card text');
    });

    it('should import a modern zstd+protobuf package, with media and nested deck names', async () => {
        // The format Anki exports by default since 2.1.50. Before ankiPackage.js this
        // threw outright: the collection is a zstd frame, not a SQLite file.
        const dbPath = path.join(process.cwd(), `temp_anki_modern_${Date.now()}.db`);
        const png = Buffer.from('modern_png_payload_unique');

        buildModernAnkiDb(dbPath, {
            // \x1f is how schema 15+ stores "Japanese::Vocabulary"
            decks: [{ id: 500, name: 'Japanese\x1fVocabulary' }],
            notetypes: [{
                id: 1000, name: 'Japanese Recognition', kind: 0,
                flds: [{ name: 'Expression' }, { name: 'Meaning' }],
                tmpls: [{ name: 'Card 1', qfmt: '{{Expression}}', afmt: '{{FrontSide}}<hr>{{Meaning}}' }],
            }],
            notes: [{ id: 9001, guid: 'mguid1', mid: 1000, flds: '食べる <img src="taberu.png">\x1fto eat' }],
            cards: [{ id: 9101, nid: 9001, did: 500, ord: 0, reps: 6 }],
        });

        const zipBuffer = buildModernApkg(dbPath, [{ name: 'taberu.png', data: png }]);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        const result = await importer.importApkg(zipBuffer, '');
        assert.ok(result.ok);

        // "::" separator restored from \x1f, then sanitised the same way legacy names are
        const deck = await importer.query.db.prepare('SELECT * FROM Decks WHERE name = ?').get('Japanese_Vocabulary');
        assert.ok(deck, 'Nested deck name should round-trip through the \\x1f separator');

        const entries = await importer.query.getDeckEntries(deck.id, 'owner');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].card_type, 'basic');
        assert.equal(entries[0].frontText, '食べる');
        assert.equal(entries[0].backText, 'to eat');

        const sha = crypto.createHash('sha256').update(png).digest('hex');
        const mediaRow = await importer.query.db.prepare('SELECT * FROM Media WHERE hash = ?').get(sha);
        assert.ok(mediaRow, 'Media must be decompressed and hashed by its original bytes');
    });

    it('should read cloze kind and {{type:}} out of the protobuf template config', async () => {
        // Both signals live only in a protobuf BLOB in the modern schema — `notetypes`
        // has no `kind` column and `templates` no `qfmt` column. Without decoding them
        // every modern notetype degrades to a positional basic card.
        const dbPath = path.join(process.cwd(), `temp_anki_modern_types_${Date.now()}.db`);

        buildModernAnkiDb(dbPath, {
            decks: [{ id: 501, name: 'Modern_Types' }],
            notetypes: [
                {
                    id: 1001, name: 'Cloze', kind: 1,
                    flds: [{ name: 'Text' }, { name: 'Back Extra' }],
                    tmpls: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Back Extra}}' }],
                },
                {
                    id: 1002, name: 'Basic (type in the answer)', kind: 0,
                    flds: [{ name: 'Front' }, { name: 'Back' }],
                    tmpls: [{ name: 'Card 1', qfmt: '{{Front}}\n{{type:Back}}', afmt: '{{FrontSide}}<hr>{{Back}}' }],
                },
            ],
            notes: [
                { id: 9002, guid: 'mguid2', mid: 1001, flds: 'The {{c1::mitochondria}} is the powerhouse.\x1f' },
                { id: 9003, guid: 'mguid3', mid: 1002, flds: 'Capital of Japan?\x1fTokyo' },
            ],
            cards: [
                { id: 9102, nid: 9002, did: 501, ord: 0, reps: 3 },
                { id: 9103, nid: 9003, did: 501, ord: 0, reps: 0 },
            ],
        });

        const zipBuffer = buildModernApkg(dbPath);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        assert.ok((await importer.importApkg(zipBuffer, '')).ok);

        const deck = await importer.query.db.prepare('SELECT * FROM Decks WHERE name = ?').get('Modern_Types');
        const entries = await importer.query.getDeckEntries(deck.id, 'owner');
        assert.equal(entries.length, 2);

        const cloze = entries.find(e => e.card_type === 'cloze');
        assert.ok(cloze, 'notetypes.config kind=1 must be decoded as cloze');
        assert.ok(cloze.frontText.includes('{{mitochondria}}'));

        const typed = entries.find(e => e.card_type === 'type_answer');
        assert.ok(typed, '{{type:Back}} in the protobuf qfmt must be decoded');
        assert.equal(typed.frontText, 'Capital of Japan?');
        assert.equal(typed.answerText, 'Tokyo', 'the {{type:}} field becomes the compared answer');
    });

    it('should dedupe one asset across a legacy and a zstd package to a single Media row', async () => {
        // Pins the ordering inside _copyMedia: decompress first, then hash. Hashing the
        // stored bytes would make the same file look like two different assets.
        const payload = Buffer.from(`shared_asset_${Date.now()}`);
        const importer = new AnkiImport();

        const legacyDb = path.join(process.cwd(), `temp_anki_dedupe_legacy_${Date.now()}.db`);
        const assetPath = path.join(process.cwd(), `temp_shared_${Date.now()}.png`);
        fs.writeFileSync(assetPath, payload);
        buildAnkiDb(legacyDb, {
            decks: { 600: { id: 600, name: 'Dedupe_Legacy' } },
            models: {
                1100: {
                    id: 1100, name: 'Basic', type: 0,
                    flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
                    tmpls: [{ ord: 0, name: 'Card 1', qfmt: '{{Front}}', afmt: '{{Back}}' }],
                },
            },
            notes: [{ id: 9500, guid: 'dg1', mid: 1100, flds: 'A <img src="shared.png">\x1fB' }],
            cards: [{ id: 9600, nid: 9500, did: 600, ord: 0 }],
        });
        const legacyZip = new AdmZip();
        legacyZip.addLocalFile(legacyDb, '', 'collection.anki21');
        legacyZip.addLocalFile(assetPath, '', '0');
        legacyZip.addFile('media', Buffer.from(JSON.stringify({ '0': 'shared.png' })));
        await importer.importApkg(legacyZip.toBuffer(), '');
        fs.unlinkSync(legacyDb);
        fs.unlinkSync(assetPath);

        const modernDb = path.join(process.cwd(), `temp_anki_dedupe_modern_${Date.now()}.db`);
        buildModernAnkiDb(modernDb, {
            decks: [{ id: 601, name: 'Dedupe_Modern' }],
            notetypes: [{
                id: 1101, name: 'Basic', kind: 0,
                flds: [{ name: 'Front' }, { name: 'Back' }],
                tmpls: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{Back}}' }],
            }],
            notes: [{ id: 9501, guid: 'dg2', mid: 1101, flds: 'A <img src="shared.png">\x1fB' }],
            cards: [{ id: 9601, nid: 9501, did: 601, ord: 0 }],
        });
        await importer.importApkg(buildModernApkg(modernDb, [{ name: 'shared.png', data: payload }]), '');
        fs.unlinkSync(modernDb);

        const sha = crypto.createHash('sha256').update(payload).digest('hex');
        const rows = await importer.query.db.prepare('SELECT * FROM Media WHERE hash = ?').all(sha);
        assert.equal(rows.length, 1, 'The same asset from both package formats must dedupe');
    });

    it('should report notetypes, samples and a suggested mapping from analyze()', async () => {
        const dbPath = path.join(process.cwd(), `temp_anki_analyze_${Date.now()}.db`);

        buildModernAnkiDb(dbPath, {
            decks: [{ id: 700, name: 'Analyze_Deck' }],
            notetypes: [{
                id: 1200, name: 'Japanese', kind: 0,
                flds: [
                    { name: 'Expression' },
                    { name: 'Meaning', description: 'English gloss' },
                    { name: 'Audio' },
                    { name: 'Notes' },
                ],
                tmpls: [{ name: 'Card 1', qfmt: '{{Expression}}{{Audio}}', afmt: '{{FrontSide}}<hr>{{Meaning}}' }],
            }],
            notes: [{ id: 9700, guid: 'ag1', mid: 1200, flds: '食べる\x1fto eat\x1f[sound:taberu.mp3]\x1fichidan verb' }],
            cards: [{ id: 9800, nid: 9700, did: 700, ord: 0 }],
        });

        const zipBuffer = buildModernApkg(dbPath, [{ name: 'taberu.mp3', data: Buffer.from('mp3') }]);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        const report = await importer.analyze(zipBuffer);

        assert.ok(report.sessionId, 'analyze must hand back a session id');
        assert.equal(report.version, 3);
        assert.equal(report.totalNotes, 1);
        assert.equal(report.notetypes.length, 1);

        const nt = report.notetypes[0];
        assert.equal(nt.name, 'Japanese');
        assert.equal(nt.noteCount, 1);
        assert.deepEqual(nt.fields.map(f => f.name), ['Expression', 'Meaning', 'Audio', 'Notes']);
        assert.equal(nt.fields[1].description, 'English gloss', 'field descriptions come from the protobuf config');
        assert.deepEqual(nt.samples[0], ['食べる', 'to eat', '[sound:taberu.mp3]', 'ichidan verb']);

        assert.equal(nt.suggested.cardType, 'basic');
        assert.deepEqual(nt.suggested.slots.front, ['Expression']);
        assert.deepEqual(nt.suggested.slots.back, ['Meaning']);
        // A field holding nothing but [sound:] belongs in the audio slot, not appended
        // to the question text as a literal "[sound:taberu.mp3]".
        assert.deepEqual(nt.suggested.slots.front_sound, ['Audio']);
        // Referenced by no template → left unassigned for the user to place or drop.
        assert.ok(
            !Object.values(nt.suggested.slots).some(names => names.includes('Notes')),
            'Unreferenced fields stay unassigned'
        );

        // The session survives analyze so the apply phase needs no second upload.
        const applied = await importer.importApkg(null, '', {
            1200: { cardType: 'basic', slots: { front: ['Expression'], back: ['Meaning', 'Notes'], front_sound: ['Audio'] } },
        }, report.sessionId);
        assert.ok(applied.ok);
        assert.equal(applied.imported, 1);

        const deck = await importer.query.db.prepare('SELECT * FROM Decks WHERE name = ?').get('Analyze_Deck');
        const entries = await importer.query.getDeckEntries(deck.id, 'owner');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].frontText, '食べる');
        // Two fields into one slot concatenate in the order they were mapped.
        assert.equal(entries[0].backText, 'to eat\n\nichidan verb');
    });

    it('should serve session media decompressed so the mapper can preview it', async () => {
        // The mapping UI has to show images and play sounds *before* importing —
        // that is how the user decides whether a sound belongs with the question or
        // the answer. Bytes must come back identical to the originals, out of a zstd
        // package, without anything being written to the vault.
        const dbPath = path.join(process.cwd(), `temp_anki_sessmedia_${Date.now()}.db`);
        const mp3 = Buffer.from(`audio-payload-${Date.now()}`);
        const png = Buffer.from(`image-payload-${Date.now()}`);

        buildModernAnkiDb(dbPath, {
            decks: [{ id: 900, name: 'Session_Media' }],
            notetypes: [{
                id: 1400, name: 'Listening', kind: 0,
                flds: [{ name: 'Word' }, { name: 'Audio' }, { name: 'Picture' }],
                tmpls: [{ name: 'Card 1', qfmt: '{{Word}}{{Audio}}', afmt: '{{Picture}}' }],
            }],
            notes: [{ id: 9990, guid: 'sm1', mid: 1400, flds: 'neko\x1f[sound:neko.mp3]\x1f<img src="cat.png">' }],
            cards: [{ id: 9991, nid: 9990, did: 900, ord: 0 }],
        });

        const zipBuffer = buildModernApkg(dbPath, [
            { name: 'neko.mp3', data: mp3 },
            { name: 'cat.png', data: png },
        ]);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        const report = await importer.analyze(zipBuffer);

        const audio = importer.readSessionMedia(report.sessionId, 'neko.mp3');
        assert.ok(audio, 'session audio should resolve by its original filename');
        assert.deepEqual(audio.buffer, mp3, 'bytes must be decompressed, not the zstd frame');

        const image = importer.readSessionMedia(report.sessionId, 'cat.png');
        assert.ok(image);
        assert.deepEqual(image.buffer, png);

        assert.equal(importer.readSessionMedia(report.sessionId, 'nope.mp3'), null);
        // Path traversal in the session id must not reach outside the session root.
        assert.equal(importer.readSessionMedia('../../etc', 'neko.mp3'), null);
        assert.equal(importer.readSessionMedia('does-not-exist', 'neko.mp3'), null);

        // Previewing must not have imported anything.
        assert.equal(
            (await importer.query.db.prepare('SELECT COUNT(*) AS n FROM Media WHERE hash = ?')
                .get(crypto.createHash('sha256').update(mp3).digest('hex'))).n,
            0,
            'analyze + preview must not write to the vault'
        );

        // The session is still usable for the real import afterwards.
        const applied = await importer.importApkg(null, '', null, report.sessionId);
        assert.ok(applied.ok);
        assert.equal(applied.imported, 1);
    });

    it('should honour an explicit mapping: media slots, concatenation and dropped fields', async () => {
        const dbPath = path.join(process.cwd(), `temp_anki_mapping_${Date.now()}.db`);
        const jpg = Buffer.from(`mapping_image_${Date.now()}`);

        buildModernAnkiDb(dbPath, {
            decks: [{ id: 800, name: 'Mapping_Deck' }],
            notetypes: [{
                id: 1300, name: 'Rich', kind: 0,
                flds: [{ name: 'Term' }, { name: 'Definition' }, { name: 'Example' }, { name: 'Picture' }, { name: 'Junk' }],
                tmpls: [{ name: 'Card 1', qfmt: '{{Term}}', afmt: '{{Definition}}' }],
            }],
            notes: [{
                id: 9900, guid: 'mp1', mid: 1300,
                flds: 'Ephemeral\x1fLasting a short time\x1f"a fad is ephemeral"\x1f<img src="pic.jpg">\x1finternal-tracking-id-42',
            }],
            cards: [{ id: 9950, nid: 9900, did: 800, ord: 0 }],
        });

        const zipBuffer = buildModernApkg(dbPath, [{ name: 'pic.jpg', data: jpg }]);
        fs.unlinkSync(dbPath);

        const importer = new AnkiImport();
        const result = await importer.importApkg(zipBuffer, '', {
            1300: {
                cardType: 'basic',
                slots: {
                    front: ['Term'],
                    back: ['Definition', 'Example'],
                    back_img: ['Picture'],
                    // "Junk" is in no slot at all → dropped
                },
            },
        });
        assert.ok(result.ok);

        const deck = await importer.query.db.prepare('SELECT * FROM Decks WHERE name = ?').get('Mapping_Deck');
        const entries = await importer.query.getDeckEntries(deck.id, 'owner');
        assert.equal(entries.length, 1);
        assert.equal(entries[0].frontText, 'Ephemeral');
        assert.equal(entries[0].backText, 'Lasting a short time\n\n"a fad is ephemeral"');
        assert.ok(!entries[0].backText.includes('internal-tracking-id-42'), 'Unmapped fields must be dropped');

        const sha = crypto.createHash('sha256').update(jpg).digest('hex');
        assert.ok(
            await importer.query.db.prepare('SELECT * FROM Media WHERE hash = ?').get(sha),
            'A field dragged onto a media slot contributes its asset'
        );
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

        const docA = await importer.documents.query.getDocumentByPath(path.join(result.path, 'Mitochondria.md'));
        const docB = await importer.documents.query.getDocumentByPath(path.join(result.path, 'Cell Membrane.md'));
        assert.ok(docA, 'Mitochondria.md should be imported');
        assert.ok(docB, 'Cell Membrane.md should be imported');

        const contentA = importer.files.readFile(path.join(result.path, 'Mitochondria.md')).content;
        assert.ok(contentA.includes('flashback://'), 'Wiki links should be converted to flashback://');

        const cardsA = await importer.documents.query.getFlashcardsByDocument(docA.id, 'owner');
        assert.equal(cardsA.length, 3, 'Mitochondria.md should have 3 flashcards');
        assert.ok(cardsA.some(c => c.card_type === 'basic'));
        assert.ok(cardsA.some(c => c.card_type === 'cloze'));

        const tagsA = await importer.documents.query.getDirectTagNames(docA.node_id);
        assert.ok(tagsA.includes('science'));
        assert.ok(tagsA.includes('bio'));
    });
});
