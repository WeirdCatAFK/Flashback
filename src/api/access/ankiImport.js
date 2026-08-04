/**
 * ankiImport.js
 * Orchestrator to parse and import Anki .apkg packages into Flashback.
 *
 * Anki has no fixed card shape: a notetype declares N named fields, and its
 * templates decide which field renders where. Flashback has five card types with
 * fixed slots. Import is therefore a projection, and it happens in two phases so
 * the user can steer it:
 *
 *   analyze(buffer)  → what notetypes are in here, what fields do they have,
 *                      what would we guess, and what does a real note look like
 *   importApkg(...)  → apply a per-notetype mapping of fields onto card slots
 *
 * Calling `importApkg` without a mapping just uses the guess, so every existing
 * caller keeps working and there is only one code path to reason about.
 *
 * Reading the package itself — the three zip generations, zstd, protobuf — is
 * `ankiPackage.js`'s job, not this module's.
 */

import BetterSQLite from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Files from './files.js';
import query from './query.js';
import db from './database.js';
import Decks from './decks.js';
import { openPackage, readCollection, readMediaFile } from './ankiPackage.js';

const SESSION_ROOT = path.join(os.tmpdir(), 'flashback_anki_imports');
const SESSION_TTL_MS = 60 * 60 * 1000; // an abandoned mapping modal must not leak a temp dir
// Written by analyze() into the session dir so the apply phase can rebuild the
// package handle (collection path, media map) without the original bytes.
const SESSION_MARKER = '.flashback-session.json';

/** Card slots a mapping may target. `front`/`back` are text; the rest are media. */
export const CARD_SLOTS = ['front', 'back', 'front_img', 'front_sound', 'back_img', 'back_sound'];
const MEDIA_SLOTS = { front_img: 'img', front_sound: 'snd', back_img: 'img', back_sound: 'snd' };

const emptySlots = () => ({ front: [], back: [], front_img: [], front_sound: [], back_img: [], back_sound: [] });

// Anki embeds media inside field HTML rather than in a separate column, so a
// field's value has to be split into "text" and "the assets it mentions".
const MEDIA_PATTERNS = [
    { kind: 'img', re: /<img[^>]+src=["']([^"']+)["'][^>]*>/gi },
    { kind: 'snd', re: /\[sound:([^\]]+)\]/gi },
    { kind: 'snd', re: /<(?:audio|source|embed)[^>]+src=["']([^"']+)["'][^>]*>/gi },
];

function extractMediaRefs(text) {
    let stripped = text || '';
    const imgs = [];
    const snds = [];
    for (const { kind, re } of MEDIA_PATTERNS) {
        for (const match of [...stripped.matchAll(re)]) {
            (kind === 'img' ? imgs : snds).push(match[1]);
            stripped = stripped.replace(match[0], '');
        }
    }
    return { imgs, snds, stripped };
}

function htmlToMarkdown(html) {
    if (!html) return "";
    let text = html;

    // Strip style/script blocks entirely — their text content is not a tag and
    // would survive the catch-all tag stripper below as literal CSS/JS text.
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    // Convert <pre> blocks to fenced code blocks before stripping other tags.
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
        const code = content.replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return '\n```\n' + code.trim() + '\n```\n';
    });

    // Convert divs whose class name contains "code" to fenced code blocks.
    // Handles the common Anki pattern of <div class="code-block"><span ...>...</span></div>.
    text = text.replace(/<div[^>]+class="[^"]*\bcode\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi, (_, content) => {
        const code = content.replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return '\n```\n' + code.trim() + '\n```\n';
    });

    // Inline <code> spans.
    text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, content) => {
        const code = content.replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return '`' + code + '`';
    });

    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/div>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<p>/gi, '');
    text = text.replace(/<div>/gi, '');
    text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
    text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
    text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
    text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
    text = text.replace(/<[^>]+>/g, '');
    text = text
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
    // Collapse runs of blank lines to at most two.
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

// Short, single-line label for card lists — derived from actual content so
// imported cards read the same way as ones created through FlashcardForm,
// instead of a generic "Anki Card N" placeholder.
function deriveCardName(text, fallback = 'Untitled card') {
    const clean = (text || '').replace(/\s+/g, ' ').trim();
    return clean ? clean.slice(0, 80) : fallback;
}

export default class AnkiImport {
    constructor() {
        this.files = new Files();
        this.query = query;
        this.decksService = new Decks();
    }

    /* ------------------------------------------------------------------ *
     * Template inspection
     * ------------------------------------------------------------------ */

    /**
     * Field names a template actually references, in template order.
     *
     * Strips the `type:`/`cloze:`/`hint:` modifier prefixes and the `#`/`^`/`/`
     * conditional markers, so `{{cloze:Text}}` resolves to the field `Text`
     * rather than to a field literally named "cloze:Text" — the bug that used to
     * drop cloze content whenever an add-on wrapped the placeholder.
     */
    _templateFields(fmt, fieldNames) {
        const out = [];
        for (const match of (fmt || '').matchAll(/\{\{(?:[#/^])?(?:type:|cloze:|hint:)?([^/{}#^]+)\}\}/g)) {
            const name = match[1].trim();
            if (fieldNames.includes(name) && !out.includes(name)) out.push(name);
        }
        return out;
    }

    /**
     * Maps an Anki model to one of Flashback's five card types using reliable
     * signals in priority order.
     */
    _detectCardType(model, qfmt) {
        // Numeric type field is the authoritative cloze indicator
        if (model.type === 1) return 'cloze';
        // Template qfmt uses {{type:Field}} → user must type the answer
        if (qfmt && /\{\{type:/i.test(qfmt)) return 'type_answer';
        // Image Occlusion is identified by the well-known model name pattern
        if (/image.?occlusion/i.test(model.name || '')) return 'custom';
        // Two or more templates means Basic+Reversed (or similar bidirectional model)
        if ((model.tmpls || []).length >= 2) return 'reversible';
        return 'basic';
    }

    /**
     * Reads the notetype's own templates backwards into a proposed field→slot
     * mapping. This is what the mapping screen pre-fills, and what a caller that
     * supplies no mapping gets, so a well-formed Basic deck imports untouched.
     *
     * @param {object} model - normalized model from ankiPackage.readCollection
     * @param {string[][]} samples - raw field-value rows, used to spot fields that
     *   hold nothing but a media reference (an "Audio" field belongs in a sound
     *   slot, not concatenated into the answer text as `[sound:x.mp3]`)
     */
    _suggestMapping(model, samples = []) {
        const fieldNames = (model.flds || []).map(f => f.name);
        const tmpl = (model.tmpls || [])[0] ?? {};
        const qfmt = tmpl.qfmt || '';
        const afmt = tmpl.afmt || '';
        const cardType = this._detectCardType(model, qfmt);
        const slots = emptySlots();

        if (cardType === 'custom') return { cardType, slots };

        // A field whose every sample is media-only should land in a media slot.
        const mediaKindOf = (name) => {
            const ord = fieldNames.indexOf(name);
            const values = samples.map(row => row[ord] ?? '').filter(v => v.trim());
            if (!values.length) return null;
            let kind = null;
            for (const value of values) {
                const { imgs, snds, stripped } = extractMediaRefs(value);
                if (htmlToMarkdown(stripped)) return null;      // carries real text too
                if (!imgs.length && !snds.length) return null;
                const thisKind = imgs.length ? 'img' : 'snd';
                if (kind && kind !== thisKind) return null;
                kind = thisKind;
            }
            return kind;
        };

        const assign = (name, side) => {
            const kind = mediaKindOf(name);
            if (kind) slots[`${side}_${kind === 'img' ? 'img' : 'sound'}`].push(name);
            else slots[side].push(name);
        };

        if (cardType === 'cloze') {
            // The cloze field is whichever one the template pipes through {{cloze:}};
            // everything else on the notetype (typically "Back Extra") is extra.
            const clozeMatch = qfmt.match(/\{\{cloze:([^}]+)\}\}/i);
            const clozeField = clozeMatch && fieldNames.includes(clozeMatch[1].trim())
                ? clozeMatch[1].trim()
                : fieldNames[0];
            if (clozeField) slots.front.push(clozeField);
            return { cardType, slots };
        }

        if (cardType === 'type_answer') {
            const typeMatch = qfmt.match(/\{\{type:([^}]+)\}\}/i);
            const answerField = typeMatch?.[1]?.trim();
            const qfmtWithoutType = qfmt.replace(/\{\{type:[^}]+\}\}/gi, '');
            for (const name of this._templateFields(qfmtWithoutType, fieldNames)) assign(name, 'front');
            if (answerField && fieldNames.includes(answerField)) slots.back.push(answerField);
            else if (fieldNames[1]) slots.back.push(fieldNames[1]);
            if (!slots.front.length && fieldNames[0]) slots.front.push(fieldNames[0]);
            return { cardType, slots };
        }

        // basic / reversible: the question template feeds the front, and whatever the
        // answer template adds on top of it feeds the back. {{FrontSide}} is not a
        // field, so it never appears in _templateFields and needs no special case.
        for (const name of this._templateFields(qfmt, fieldNames)) assign(name, 'front');
        for (const name of this._templateFields(afmt, fieldNames)) {
            if (!slots.front.includes(name) && !slots.front_img.includes(name) && !slots.front_sound.includes(name)) {
                assign(name, 'back');
            }
        }

        // A notetype whose templates reference nothing we recognise still has to
        // produce a usable card, so fall back to Anki's own field order.
        if (!slots.front.length && !slots.front_img.length && !slots.front_sound.length && fieldNames[0]) {
            slots.front.push(fieldNames[0]);
        }
        if (!slots.back.length && !slots.back_img.length && !slots.back_sound.length && fieldNames[1]) {
            slots.back.push(fieldNames[1]);
        }

        return { cardType, slots };
    }

    /* ------------------------------------------------------------------ *
     * Phase 1 — analyze
     * ------------------------------------------------------------------ */

    /** Deletes session dirs older than the TTL. Cheap, and runs before each analyze. */
    _sweepSessions() {
        if (!fs.existsSync(SESSION_ROOT)) return;
        const cutoff = Date.now() - SESSION_TTL_MS;
        for (const name of fs.readdirSync(SESSION_ROOT)) {
            const dir = path.join(SESSION_ROOT, name);
            try {
                if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
            } catch { /* another import may have just removed it */ }
        }
    }

    /**
     * Inspects a package without importing anything, and keeps the extracted files
     * around under a session id so the apply phase doesn't need a second upload.
     *
     * @param {Buffer} fileBuffer
     * @returns {Promise<object>} notetype inventory with suggested mappings and samples
     */
    async analyze(fileBuffer) {
        this._sweepSessions();

        const sessionId = crypto.randomUUID();
        const tempRoot = path.join(SESSION_ROOT, sessionId);
        let ankiDb = null;

        try {
            const pkg = openPackage(fileBuffer, tempRoot);
            fs.writeFileSync(path.join(tempRoot, SESSION_MARKER), JSON.stringify(pkg));

            ankiDb = new BetterSQLite(pkg.collectionPath, { readonly: true });
            const { decks, models } = readCollection(ankiDb);

            const noteCounts = new Map();
            for (const row of ankiDb.prepare('SELECT mid, COUNT(*) AS cnt FROM notes GROUP BY mid').all()) {
                noteCounts.set(String(row.mid), row.cnt);
            }

            const sampleStmt = ankiDb.prepare('SELECT flds FROM notes WHERE mid = ? LIMIT 3');
            const notetypes = Object.entries(models)
                .filter(([id]) => noteCounts.has(String(id)))
                .map(([id, model]) => {
                    const samples = sampleStmt.all(model.id ?? id).map(r => String(r.flds).split('\x1f'));
                    return {
                        id: String(id),
                        name: model.name,
                        noteCount: noteCounts.get(String(id)) ?? 0,
                        fields: (model.flds || []).map(f => ({
                            ord: f.ord, name: f.name, description: f.description ?? '',
                        })),
                        templates: (model.tmpls || []).map(t => ({ ord: t.ord, name: t.name })),
                        suggested: this._suggestMapping(model, samples),
                        // Capped: a field can hold a base64 data URI, and this payload
                        // only has to be big enough to recognise the field by eye.
                        samples: samples.map(row => row.map(v => String(v ?? '').slice(0, 500))),
                    };
                });

            const deckCounts = ankiDb.prepare(
                'SELECT did, COUNT(DISTINCT nid) AS cnt FROM cards GROUP BY did'
            ).all();

            return {
                sessionId,
                version: pkg.version,
                totalNotes: [...noteCounts.values()].reduce((a, b) => a + b, 0),
                decks: deckCounts.map(d => ({
                    id: String(d.did),
                    name: decks[d.did]?.name ?? 'Default',
                    noteCount: d.cnt,
                })),
                notetypes,
            };
        } catch (e) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
            console.error('Anki analyze failed:', e);
            throw e;
        } finally {
            ankiDb?.close();
        }
    }

    /* ------------------------------------------------------------------ *
     * Phase 2 — apply
     * ------------------------------------------------------------------ */

    /**
     * Projects one Anki note onto Flashback card content using the notetype's mapping.
     *
     * Slot rules:
     *  - several fields may share a slot; they concatenate in the order given
     *  - a field in a *text* slot keeps its text, and media found inside it still
     *    fills the matching media slot (so an inline <img> is not lost)
     *  - a field in a *media* slot contributes only its first asset; its text is dropped
     *  - a field in no slot is dropped
     */
    _applyMapping(primaryCard, model, mapping, ctx) {
        const noteFields = String(primaryCard.note_fields).split('\x1f');
        const byName = {};
        (model.flds || []).forEach(f => { byName[f.name] = noteFields[f.ord] ?? ''; });

        const cardType = mapping.cardType;
        const slots = { ...emptySlots(), ...(mapping.slots || {}) };

        const resolve = (name) => this._copyMedia(name, ctx)?.fileHash ?? null;
        const joinFields = (names) => (names || [])
            .map(n => byName[n] ?? '')
            .filter(v => v.trim())
            .join('\n\n');

        if (cardType === 'custom') {
            // Image Occlusion and other rich-HTML notetypes: keep the rendered question
            // side verbatim rather than flattening it, and still pull its media across.
            const tmpl = (model.tmpls || [])[primaryCard.card_ord] ?? (model.tmpls || [])[0] ?? {};
            const html = (tmpl.qfmt || '').replace(
                /\{\{(?:[#/^])?(?:type:|cloze:|hint:)?([^/{}#^]+)\}\}/g,
                (_, name) => byName[name.trim()] ?? ''
            ).replace(/\{\{FrontSide\}\}/g, '').trim() || joinFields(Object.keys(byName));

            const { imgs, snds } = extractMediaRefs(html);
            [...imgs, ...snds].forEach(resolve);
            return {
                cardType: 'custom',
                name: deriveCardName(htmlToMarkdown(html), 'Custom card'),
                customHtml: html,
            };
        }

        // Text slots, with their inline media pulled out.
        const front = extractMediaRefs(joinFields(slots.front));
        const back = extractMediaRefs(joinFields(slots.back));

        // Explicit media slots win over media that merely happened to sit inside a
        // text field, which is the whole point of dragging a field onto a media zone.
        const mediaFor = (slot) => {
            const kind = MEDIA_SLOTS[slot];
            const raw = joinFields(slots[slot]);
            if (raw) {
                const refs = extractMediaRefs(raw);
                const explicit = (kind === 'img' ? refs.imgs : refs.snds)[0];
                if (explicit) return resolve(explicit);
                // Some decks store a bare filename with no <img>/[sound:] wrapper.
                const bare = htmlToMarkdown(refs.stripped).trim();
                if (bare && Object.values(ctx.mediaMap).includes(bare)) return resolve(bare);
            }
            const side = slot.startsWith('front') ? front : back;
            const inline = (kind === 'img' ? side.imgs : side.snds)[0];
            return inline ? resolve(inline) : null;
        };

        const media = {
            front_img: mediaFor('front_img'),
            front_sound: mediaFor('front_sound'),
            back_img: mediaFor('back_img'),
            back_sound: mediaFor('back_sound'),
        };

        if (cardType === 'cloze') {
            // Normalise Anki cloze syntax {{c1::answer::hint}} → {{answer}}
            const clozeText = htmlToMarkdown(front.stripped.replace(/{{c\d+::([^:}]+)(?:::[^}]*)?}}/g, '{{$1}}'));
            return {
                cardType: 'cloze',
                name: deriveCardName(clozeText.replace(/\{\{([^}]+)\}\}/g, '$1')),
                frontText: clozeText,
                backText: clozeText,
                media,
            };
        }

        const frontText = htmlToMarkdown(front.stripped);
        return {
            cardType,
            name: deriveCardName(frontText),
            frontText,
            backText: htmlToMarkdown(back.stripped),
            media,
        };
    }

    /**
     * Imports an Anki .apkg into standalone decks.
     *
     * @param {Buffer|null} fileBuffer - raw package bytes; may be null when `sessionId` is given
     * @param {string} targetRelPath - accepted for signature parity with the other
     *   importers and deliberately ignored: Anki notes become standalone cards in
     *   decks, which have no location in the workspace tree
     * @param {object|null} mapping - `{ [notetypeId]: { cardType, slots } }`; the
     *   per-notetype suggestion is used for anything not covered
     * @param {string|null} sessionId - reuse an `analyze()` extraction instead of re-reading
     * @returns {Promise<{ ok: boolean, path: string, imported: number }>}
     */
    async importApkg(fileBuffer, targetRelPath = "", mapping = null, sessionId = null) {
        console.log(
            'Importing Anki package into standalone decks' +
            (targetRelPath ? ` (ignoring requested target "${targetRelPath}")` : '')
        );

        const sessionRoot = sessionId ? path.join(SESSION_ROOT, sessionId) : null;
        const reuseSession = Boolean(sessionRoot && fs.existsSync(sessionRoot));
        const tempRoot = reuseSession ? sessionRoot : path.join(SESSION_ROOT, crypto.randomUUID());
        let ankiDb = null;

        try {
            let pkg;
            if (reuseSession) {
                // Reuse analyze()'s extraction — no second unzip, no second upload.
                pkg = this._reopenSession(tempRoot);
            } else {
                if (!fileBuffer) throw new Error('Anki import needs either a file or a valid session id.');
                pkg = openPackage(fileBuffer, tempRoot);
            }

            ankiDb = new BetterSQLite(pkg.collectionPath, { readonly: true });
            const { decks, models } = readCollection(ankiDb);

            const cards = ankiDb.prepare(`
                SELECT c.id as card_id, c.nid as note_id, c.did as deck_id, c.ord as card_ord,
                       c.reps, c.factor, c.ivl,
                       n.mid as model_id, n.tags as note_tags, n.flds as note_fields, n.guid as note_guid
                FROM cards c
                JOIN notes n ON c.nid = n.id
            `).all();

            // Group cards by note_id so we create one Flashback card per Anki note,
            // not one per Anki card (which would duplicate Basic+Reversed and cloze notes).
            const cardsByNote = new Map();
            for (const card of cards) {
                if (!cardsByNote.has(card.note_id)) cardsByNote.set(card.note_id, []);
                cardsByNote.get(card.note_id).push(card);
            }

            // Group notes by their deck (using the primary card's deck_id)
            const notesByDeck = new Map();
            for (const [, noteCards] of cardsByNote) {
                const primaryCard = noteCards.find(c => c.card_ord === 0) ?? noteCards[0];
                const deckInfo = decks[primaryCard.deck_id] || { name: 'Default' };
                const deckName = deckInfo.name.replace(/::/g, '_').replace(/[^\w.-]+/g, '_') || 'Default';
                if (!notesByDeck.has(deckName)) notesByDeck.set(deckName, []);
                notesByDeck.get(deckName).push(primaryCard);
            }

            const importFolderName = `Anki_Import_${Date.now()}`;
            const mediaDirAbs = path.join(this.files.workspaceRoot, 'media');
            if (!fs.existsSync(mediaDirAbs)) fs.mkdirSync(mediaDirAbs, { recursive: true });

            const ctx = { mediaMap: pkg.mediaMap, tempRoot, mediaDirAbs, mediaDirRel: 'media' };

            // Resolve the mapping once per notetype rather than per note.
            const mappings = new Map();
            const mappingFor = (modelId, model) => {
                const key = String(modelId);
                if (!mappings.has(key)) {
                    const supplied = mapping?.[key];
                    mappings.set(key, supplied?.cardType ? supplied : this._suggestMapping(model));
                }
                return mappings.get(key);
            };

            let imported = 0;

            for (const [deckName, primaryCards] of notesByDeck.entries()) {
                const allDecks = this.query.getAllDecks();
                const existingDeck = allDecks.find(d => d.name === deckName);
                const deckHash = existingDeck
                    ? existingDeck.global_hash
                    : await this.decksService.createDeck(deckName, 'Imported from Anki package.');

                for (const primaryCard of primaryCards) {
                    const model = models[primaryCard.model_id] || { name: 'Basic', flds: [], tmpls: [] };
                    const content = this._applyMapping(primaryCard, model, mappingFor(primaryCard.model_id, model), ctx);

                    const globalHash = await this.decksService.createStandaloneCard({
                        name: content.name,
                        cardType: content.cardType,
                        category: 'Concept',
                        customHtml: content.customHtml ?? null,
                        frontText: content.frontText,
                        backText: content.backText,
                        media: content.media,
                    });

                    await this.decksService.addEntry(deckHash, { cardHash: globalHash });
                    imported++;

                    // Replay Anki SRS history onto the new card
                    const cardInDb = this.query.getFlashcardByHash(globalHash);
                    if (cardInDb) {
                        const reps = primaryCard.reps || 0;
                        const level = Math.min(5, Math.floor(reps / 3));
                        const easeFactor = primaryCard.factor
                            ? Math.min(3.0, Math.max(1.3, primaryCard.factor / 1000.0))
                            : 2.5;
                        db.transaction(() => {
                            this.query.setFlashcardSrsState(cardInDb.id, level, reps);
                            this.query.insertReviewLog({
                                flashcardId: cardInDb.id,
                                timestamp: new Date().toISOString(),
                                outcome: 1,
                                easeFactor,
                                level,
                            });
                        })();
                    }
                }
            }

            return { ok: true, path: importFolderName, imported };
        } catch (e) {
            console.error("Anki import failed:", e);
            throw e;
        } finally {
            ankiDb?.close();
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    }

    /**
     * Streams one asset out of a live `analyze()` session, by its original Anki
     * filename, decompressed.
     *
     * This exists so the mapping UI can *preview* media before anything is imported —
     * in particular so the user can hear a sound and decide whether it belongs on the
     * question side or the answer side. Nothing is written to the vault.
     *
     * @returns {{ buffer: Buffer, filename: string }|null} null if the session or asset is gone
     */
    readSessionMedia(sessionId, name) {
        // Reject anything that could escape the session dir before touching the fs.
        // (The lookup below is already indirect — `name` is matched against the media
        // map's values and only its numeric zip key is ever joined to a path — but the
        // session id comes straight off the query string.)
        if (!sessionId || /[\\/]|\.\./.test(sessionId)) return null;

        const tempRoot = path.join(SESSION_ROOT, sessionId);
        if (!fs.existsSync(path.join(tempRoot, SESSION_MARKER))) return null;

        const { mediaMap } = this._reopenSession(tempRoot);
        const wanted = String(name ?? '').toLowerCase().replace(/\\/g, '/');
        const key = Object.keys(mediaMap).find(
            k => mediaMap[k].toLowerCase().replace(/\\/g, '/') === wanted
        );
        if (!key) return null;

        const buffer = readMediaFile(tempRoot, key);
        return buffer ? { buffer, filename: mediaMap[key] } : null;
    }

    /**
     * Reads back the package handle `analyze()` recorded for a session, so the apply
     * phase reuses that extraction instead of asking for the file again.
     *
     * `openPackage` cannot simply be re-run: it needs the original bytes, which is
     * exactly what the session exists to avoid re-uploading.
     */
    _reopenSession(tempRoot) {
        const marker = path.join(tempRoot, SESSION_MARKER);
        if (!fs.existsSync(marker)) {
            throw new Error('Anki import session expired — please pick the file again.');
        }
        return JSON.parse(fs.readFileSync(marker, 'utf-8'));
    }

    /**
     * Copies one media asset out of the package into the workspace, deduping by hash.
     *
     * The bytes are hashed *after* decompression, so the same asset imported from a
     * legacy package and from a zstd one resolves to a single `Media` row.
     */
    _copyMedia(originalName, ctx) {
        const { mediaMap, tempRoot, mediaDirAbs, mediaDirRel } = ctx;
        const decodedName = decodeURIComponent(originalName)
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();
        const cleanSearch = decodedName.toLowerCase().replace(/\\/g, '/');

        let mediaKey = null;
        for (const [key, val] of Object.entries(mediaMap)) {
            if (val.toLowerCase().replace(/\\/g, '/') === cleanSearch) { mediaKey = key; break; }
        }
        if (!mediaKey) return null;

        const fileBuf = readMediaFile(tempRoot, mediaKey);
        if (!fileBuf) return null;

        const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');

        const existing = this.query.getMediaByHash(fileHash);
        if (existing) return { copiedName: existing.name, fileHash };

        const ext = path.extname(decodedName);
        const base = path.basename(decodedName, ext).replace(/[^\w.-]+/g, '_');
        const copiedName = `${base}-${crypto.randomUUID().slice(0, 8)}${ext}`;
        const destPath = path.join(mediaDirAbs, copiedName);

        fs.writeFileSync(destPath, fileBuf);
        db.transaction(() => {
            this.query.insertMedia({
                hash: fileHash,
                name: copiedName,
                relativePath: path.join(mediaDirRel, copiedName),
                absolutePath: destPath,
            });
        })();

        return { copiedName, fileHash };
    }
}
