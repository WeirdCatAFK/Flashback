/**
 * ankiPackage.js
 * Pure reader for Anki .apkg packages. No DB, no sidecars, no IO beyond the
 * temp dir it is handed — the Anki-format knowledge lives here so `ankiImport.js`
 * only has to think about mapping notes onto Flashback cards.
 *
 * An .apkg is a ZIP that comes in three generations:
 *
 *   Legacy1 (Anki 2.0)        collection.anki2   + `media` as JSON  {"0":"hola.png"}
 *   Legacy2 (2.1.0–2.1.49)    collection.anki21  + the same JSON map
 *   Latest  (2.1.50+, today)  meta + collection.anki21b + `media` as protobuf,
 *                             with the collection, the media map, and every
 *                             numbered media file individually zstd-compressed.
 *
 * The collection schema forked too. Schema 11 keeps everything in one `col` row
 * as JSON; schema 15+ split it into notetypes/fields/templates/decks tables and
 * moved the interesting parts into protobuf BLOBs in a `config` column.
 *
 * Everything here normalizes onto the *legacy* JSON shape, because that is what
 * the rest of the importer was already written against.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import AdmZip from 'adm-zip';

export const VERSION_LEGACY_1 = 1;
export const VERSION_LEGACY_2 = 2;
export const VERSION_LATEST = 3;

// zstd frame magic (RFC 8878 §3.1.1). Anki's own `meta` says which generation a
// package claims to be, but sniffing the bytes is what we actually branch on —
// a package that lies, or that we had to discover by filename because it had no
// `meta`, still decodes correctly.
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const isZstd = (buf) => buf.length >= 4 && buf.subarray(0, 4).equals(ZSTD_MAGIC);
const unzstd = (buf) => (isZstd(buf) ? zlib.zstdDecompressSync(buf) : buf);

/* ------------------------------------------------------------------ *
 * Minimal protobuf reader
 *
 * We need five scalar fields across four flat messages, so a full protobuf
 * runtime would be disproportionate — this is the same hand-rolled approach
 * `fsrs.js` takes to the FSRS-6 math. The one thing it must do properly is skip
 * fields it does not know by wire type, so a future Anki schema that adds fields
 * does not break the reader.
 * ------------------------------------------------------------------ */

function readVarint(buf, pos) {
    let result = 0n;
    let shift = 0n;
    while (pos < buf.length) {
        const byte = buf[pos++];
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return [result, pos];
        shift += 7n;
        if (shift > 70n) throw new Error('Malformed protobuf: varint exceeds 10 bytes');
    }
    throw new Error('Malformed protobuf: truncated varint');
}

/**
 * Decodes one protobuf message into `Map<fieldNumber, value[]>`. Varints arrive
 * as BigInt, length-delimited fields as Buffer. Repeated fields keep every
 * occurrence, which is how `MediaEntries.entries` is read.
 */
function decodeMessage(buf) {
    const fields = new Map();
    if (!buf || buf.length === 0) return fields;

    let pos = 0;
    while (pos < buf.length) {
        let key;
        [key, pos] = readVarint(buf, pos);
        const fieldNo = Number(key >> 3n);
        const wireType = Number(key & 7n);

        let value;
        switch (wireType) {
            case 0: [value, pos] = readVarint(buf, pos); break;
            case 1: value = buf.subarray(pos, pos + 8); pos += 8; break;
            case 2: {
                let len;
                [len, pos] = readVarint(buf, pos);
                const end = pos + Number(len);
                if (end > buf.length) throw new Error('Malformed protobuf: length-delimited field overruns message');
                value = buf.subarray(pos, end);
                pos = end;
                break;
            }
            case 5: value = buf.subarray(pos, pos + 4); pos += 4; break;
            // 3/4 are the deprecated start/end-group types. Anki emits neither.
            default: throw new Error(`Malformed protobuf: unsupported wire type ${wireType}`);
        }

        if (!fields.has(fieldNo)) fields.set(fieldNo, []);
        fields.get(fieldNo).push(value);
    }
    return fields;
}

const pbNum = (msg, no, fallback = 0) => (msg.has(no) ? Number(msg.get(no)[0]) : fallback);
const pbStr = (msg, no, fallback = '') => (msg.has(no) ? msg.get(no)[0].toString('utf-8') : fallback);
const pbRepeated = (msg, no) => msg.get(no) ?? [];

/* ------------------------------------------------------------------ *
 * Package opening
 * ------------------------------------------------------------------ */

const COLLECTION_BY_VERSION = {
    [VERSION_LEGACY_1]: 'collection.anki2',
    [VERSION_LEGACY_2]: 'collection.anki21',
    [VERSION_LATEST]: 'collection.anki21b',
};

function detectCollectionFile(tempRoot, declaredVersion) {
    const preferred = COLLECTION_BY_VERSION[declaredVersion];
    // Newest first regardless of what `meta` claimed — a package carrying both a
    // real .anki21b and a legacy stub .anki2 (Anki writes the stub so old clients
    // fail loudly rather than silently importing nothing) must use the newer one.
    const candidates = [preferred, 'collection.anki21b', 'collection.anki21', 'collection.anki2'].filter(Boolean);

    for (const name of candidates) {
        if (name && fs.existsSync(path.join(tempRoot, name))) return name;
    }

    const found = fs.readdirSync(tempRoot).find(
        f => f.endsWith('.anki2') || f.endsWith('.anki21') || f.endsWith('.anki21b') || f.includes('collection')
    );
    if (!found) throw new Error('Could not find collection SQLite database in Anki package.');
    return found;
}

function versionFromCollectionName(name) {
    if (name.endsWith('.anki21b')) return VERSION_LATEST;
    if (name.endsWith('.anki21')) return VERSION_LEGACY_2;
    return VERSION_LEGACY_1;
}

/**
 * Reads the `media` entry into `{ zipEntryName: originalFilename }` — the shape
 * the legacy JSON map already had, so media lookup downstream is version-blind.
 *
 * Legacy packages store that JSON object directly. Latest stores a protobuf
 * `MediaEntries { repeated MediaEntry entries = 1 }`, where each
 * `MediaEntry { name = 1, size = 2, sha1 = 3, optional legacy_zip_filename = 255 }`
 * is keyed by its *index* in the list unless `legacy_zip_filename` overrides it.
 */
function readMediaMap(tempRoot) {
    const mediaPath = path.join(tempRoot, 'media');
    if (!fs.existsSync(mediaPath)) return {};

    let raw;
    try {
        raw = unzstd(fs.readFileSync(mediaPath));
    } catch (e) {
        console.warn('Failed to read Anki media map:', e.message);
        return {};
    }

    // The legacy map is JSON; try it first and fall through to protobuf. Sniffing
    // the content rather than trusting the declared version keeps the two paths
    // independent of `meta` being present or honest.
    const text = raw.toString('utf-8');
    if (text.trimStart().startsWith('{')) {
        try {
            return JSON.parse(text);
        } catch {
            // Not JSON after all — fall through to the protobuf reader.
        }
    }

    try {
        const entries = pbRepeated(decodeMessage(raw), 1);
        const map = {};
        entries.forEach((entryBuf, index) => {
            const entry = decodeMessage(entryBuf);
            const name = pbStr(entry, 1);
            if (!name) return;
            const zipName = entry.has(255) ? String(pbNum(entry, 255)) : String(index);
            map[zipName] = name;
        });
        return map;
    } catch (e) {
        console.warn('Failed to parse Anki media map:', e.message);
        return {};
    }
}

/**
 * Extracts a package and locates everything the importer needs.
 *
 * @param {Buffer} buffer - raw .apkg bytes
 * @param {string} tempRoot - directory to extract into (created if absent)
 * @returns {{ version: number, zstd: boolean, collectionPath: string, mediaMap: Record<string,string>, tempRoot: string }}
 */
export function openPackage(buffer, tempRoot) {
    fs.mkdirSync(tempRoot, { recursive: true });
    new AdmZip(buffer).extractAllTo(tempRoot, true);

    let version = 0;
    const metaPath = path.join(tempRoot, 'meta');
    if (fs.existsSync(metaPath)) {
        try {
            version = pbNum(decodeMessage(fs.readFileSync(metaPath)), 1, 0);
        } catch (e) {
            console.warn('Failed to parse Anki package meta:', e.message);
        }
    }

    const collectionName = detectCollectionFile(tempRoot, version);
    if (!version) version = versionFromCollectionName(collectionName);

    // better-sqlite3 needs a real file, so a compressed collection is written back
    // out decompressed rather than opened from memory.
    let collectionPath = path.join(tempRoot, collectionName);
    const collectionBytes = fs.readFileSync(collectionPath);
    const zstd = isZstd(collectionBytes);
    if (zstd) {
        collectionPath = path.join(tempRoot, 'collection.decompressed.anki2');
        fs.writeFileSync(collectionPath, zlib.zstdDecompressSync(collectionBytes));
    }

    return { version, zstd, collectionPath, mediaMap: readMediaMap(tempRoot), tempRoot };
}

/**
 * Reads a numbered media file out of an extracted package, transparently
 * decompressing it.
 *
 * The returned bytes are always the *original* asset, which matters beyond
 * correctness: `ankiImport` hashes them to dedupe against `Media`, so the same
 * PNG imported from a legacy package and from a zstd one has to produce one row.
 *
 * @returns {Buffer|null} null when the entry is absent
 */
export function readMediaFile(tempRoot, zipEntryName) {
    const srcPath = path.join(tempRoot, zipEntryName);
    if (!fs.existsSync(srcPath)) return null;
    return unzstd(fs.readFileSync(srcPath));
}

/* ------------------------------------------------------------------ *
 * Collection reading
 * ------------------------------------------------------------------ */

// Schema 15+ stores nested deck names with \x1f between components
// (`NativeDeckName::from_human_name` joins on it); the schema 11 JSON used the
// human-readable "::". Normalizing here means callers only ever see "::".
// split/join rather than a regex: \x1f is a control character, and embedding it in
// a literal regex trips no-control-regex for no benefit here.
const humanDeckName = (name) => String(name ?? '').split('\x1f').join('::');

/**
 * Reads decks and notetypes from an open Anki collection, normalizing both
 * schema generations onto one shape:
 *
 *   models[id] = { id, name, type, sortf, css,
 *                  flds:  [{ ord, name, description }],
 *                  tmpls: [{ ord, name, qfmt, afmt }] }
 *
 * `type` keeps Anki's numbering (0 = normal, 1 = cloze) because the importer's
 * card-type detection already reads it that way.
 *
 * @param {import('better-sqlite3').Database} ankiDb
 */
export function readCollection(ankiDb) {
    const hasNotetypes = ankiDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='notetypes'"
    ).get();

    if (hasNotetypes) return readModernCollection(ankiDb);
    return readLegacyCollection(ankiDb);
}

function readModernCollection(ankiDb) {
    const decks = {};
    for (const d of ankiDb.prepare('SELECT id, name FROM decks').all()) {
        decks[d.id] = { id: d.id, name: humanDeckName(d.name) };
    }

    const models = {};
    // `notetypes` has no `kind` column — the cloze flag lives in the protobuf
    // config, alongside the css and sort field.
    for (const nt of ankiDb.prepare('SELECT id, name, config FROM notetypes').all()) {
        const cfg = decodeMessage(nt.config);

        const flds = ankiDb.prepare('SELECT ord, name, config FROM fields WHERE ntid = ? ORDER BY ord')
            .all(nt.id)
            .map(f => ({
                ord: f.ord,
                name: f.name,
                description: pbStr(decodeMessage(f.config), 5),
            }));

        const tmpls = ankiDb.prepare('SELECT ord, name, config FROM templates WHERE ntid = ? ORDER BY ord')
            .all(nt.id)
            .map(t => {
                const tcfg = decodeMessage(t.config);
                return { ord: t.ord, name: t.name, qfmt: pbStr(tcfg, 1), afmt: pbStr(tcfg, 2) };
            });

        models[nt.id] = {
            id: nt.id,
            name: nt.name,
            type: pbNum(cfg, 1, 0),
            sortf: pbNum(cfg, 2, 0),
            css: pbStr(cfg, 3),
            flds,
            tmpls,
        };
    }

    return { decks, models };
}

function readLegacyCollection(ankiDb) {
    const columns = ankiDb.prepare('PRAGMA table_info(col)').all().map(c => c.name);
    if (!columns.includes('models') || !columns.includes('decks')) {
        throw new Error(
            'Unsupported Anki collection: no `notetypes` table and no `col.models` JSON. ' +
            'Re-export the deck from Anki.'
        );
    }

    const colRow = ankiDb.prepare('SELECT decks, models FROM col LIMIT 1').get();
    if (!colRow) throw new Error("Invalid Anki collection database: 'col' table is empty.");

    const rawDecks = JSON.parse(colRow.decks);
    const decks = {};
    for (const [id, deck] of Object.entries(rawDecks)) {
        decks[id] = { id, name: humanDeckName(deck?.name) };
    }

    const rawModels = JSON.parse(colRow.models);
    const models = {};
    for (const [id, model] of Object.entries(rawModels)) {
        models[id] = {
            id,
            name: model?.name ?? 'Basic',
            type: model?.type ?? 0,
            sortf: model?.sortf ?? 0,
            css: model?.css ?? '',
            flds: (model?.flds ?? []).map((f, i) => ({
                ord: f.ord ?? i,
                name: f.name,
                description: f.description ?? '',
            })),
            tmpls: (model?.tmpls ?? []).map((t, i) => ({
                ord: t.ord ?? i,
                name: t.name,
                qfmt: t.qfmt ?? '',
                afmt: t.afmt ?? '',
            })),
        };
    }

    return { decks, models };
}

export const __testing = { decodeMessage, readVarint, isZstd };
