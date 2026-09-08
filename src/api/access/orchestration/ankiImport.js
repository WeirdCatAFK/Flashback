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
import Files from '../resources/files.js';
import query from '../resources/query.js';
import db from '../primitives/database.js';
import Decks from './decks.js';
import { openPackage, readCollection, readMediaFile } from './ankiPackage.js';
import { OWNER_SCOPE } from '../../requestContext.js';

const SESSION_ROOT = path.join(os.tmpdir(), 'flashback_anki_imports');
const SESSION_TTL_MS = 60 * 60 * 1000;
const SESSION_MARKER = '.flashback-session.json';

/** Card slots a mapping may target. */
export const CARD_SLOTS = ['front', 'back', 'answer', 'front_img', 'front_sound', 'back_img', 'back_sound'];
const MEDIA_SLOTS = { front_img: 'img', front_sound: 'snd', back_img: 'img', back_sound: 'snd' };

const emptySlots = () => ({ front: [], back: [], answer: [], front_img: [], front_sound: [], back_img: [], back_sound: [] });

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

    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
        const code = content.replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return '\n```\n' + code.trim() + '\n```\n';
    });

    text = text.replace(/<div[^>]+class="[^"]*\bcode\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi, (_, content) => {
        const code = content.replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return '\n```\n' + code.trim() + '\n```\n';
    });

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
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

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

    /** Field names a template actually references, in template order. */
    _templateFields(fmt, fieldNames) {
        const out = [];
        for (const match of (fmt || '').matchAll(/\{\{(?:[#/^])?(?:type:|cloze:|hint:)?([^/{}#^]+)\}\}/g)) {
            const name = match[1].trim();
            if (fieldNames.includes(name) && !out.includes(name)) out.push(name);
        }
        return out;
    }

    /** Maps an Anki model to one of Flashback's five card types using reliable signals in priority order. */
    _detectCardType(model, qfmt) {
        if (model.type === 1) return 'cloze';
        if (qfmt && /\{\{type:/i.test(qfmt)) return 'type_answer';
        if (/image.?occlusion/i.test(model.name || '')) return 'custom';
        if ((model.tmpls || []).length >= 2) return 'reversible';
        return 'basic';
    }

    /**
     * Reads the notetype's own templates backwards into a proposed field→slot mapping.
     *
     * @param {object} model - normalized model from ankiPackage.readCollection
     * @param {string[][]} samples - raw field-value rows, used to spot fields that hold nothing but a media reference (an "Audio" field belongs in a sound slot, not concatenated into the answer text as `[sound:x.mp3]`)
     */
    _suggestMapping(model, samples = []) {
        const fieldNames = (model.flds || []).map(f => f.name);
        const tmpl = (model.tmpls || [])[0] ?? {};
        const qfmt = tmpl.qfmt || '';
        const afmt = tmpl.afmt || '';
        const cardType = this._detectCardType(model, qfmt);
        const slots = emptySlots();

        if (cardType === 'custom') return { cardType, slots };

        const mediaKindOf = (name) => {
            const ord = fieldNames.indexOf(name);
            const values = samples.map(row => row[ord] ?? '').filter(v => v.trim());
            if (!values.length) return null;
            let kind = null;
            for (const value of values) {
                const { imgs, snds, stripped } = extractMediaRefs(value);
                if (htmlToMarkdown(stripped)) return null;
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
            const clozeMatch = qfmt.match(/\{\{cloze:([^}]+)\}\}/i);
            const clozeField = clozeMatch && fieldNames.includes(clozeMatch[1].trim())
                ? clozeMatch[1].trim()
                : fieldNames[0];
            if (clozeField) slots.front.push(clozeField);
            return { cardType, slots };
        }

        if (cardType === 'type_answer') {
            const typeMatch = qfmt.match(/\{\{type:([^}]+)\}\}/i);
            const typedField = typeMatch?.[1]?.trim();
            const qfmtWithoutType = qfmt.replace(/\{\{type:[^}]+\}\}/gi, '');
            for (const name of this._templateFields(qfmtWithoutType, fieldNames)) assign(name, 'front');

            const answerField = (typedField && fieldNames.includes(typedField)) ? typedField : fieldNames[1];
            if (answerField) slots.answer.push(answerField);

            const placed = new Set([...slots.front, ...slots.front_img, ...slots.front_sound, ...slots.answer]);
            for (const name of this._templateFields(afmt, fieldNames)) {
                if (!placed.has(name)) assign(name, 'back');
            }

            if (!slots.front.length && fieldNames[0]) slots.front.push(fieldNames[0]);
            return { cardType, slots };
        }

        for (const name of this._templateFields(qfmt, fieldNames)) assign(name, 'front');
        for (const name of this._templateFields(afmt, fieldNames)) {
            if (!slots.front.includes(name) && !slots.front_img.includes(name) && !slots.front_sound.includes(name)) {
                assign(name, 'back');
            }
        }

        if (!slots.front.length && !slots.front_img.length && !slots.front_sound.length && fieldNames[0]) {
            slots.front.push(fieldNames[0]);
        }
        if (!slots.back.length && !slots.back_img.length && !slots.back_sound.length && fieldNames[1]) {
            slots.back.push(fieldNames[1]);
        }

        return { cardType, slots };
    }

    /** Deletes session dirs older than the TTL. Cheap, and runs before each analyze. */
    _sweepSessions() {
        if (!fs.existsSync(SESSION_ROOT)) return;
        const cutoff = Date.now() - SESSION_TTL_MS;
        for (const name of fs.readdirSync(SESSION_ROOT)) {
            const dir = path.join(SESSION_ROOT, name);
            try {
                if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
            } catch { }
        }
    }

    /**
     * Inspects a package without importing anything, holding the extraction under a session id for the apply phase.
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

    /** Projects one Anki note onto Flashback card content using the notetype's mapping. */
    async _applyMapping(primaryCard, model, mapping, ctx) {
        const noteFields = String(primaryCard.note_fields).split('\x1f');
        const byName = {};
        (model.flds || []).forEach(f => { byName[f.name] = noteFields[f.ord] ?? ''; });

        const cardType = mapping.cardType;
        const slots = { ...emptySlots(), ...(mapping.slots || {}) };

        const resolve = async (name) => (await this._copyMedia(name, ctx))?.fileHash ?? null;
        const joinFields = (names) => (names || [])
            .map(n => byName[n] ?? '')
            .filter(v => v.trim())
            .join('\n\n');

        if (cardType === 'custom') {
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

        const front = extractMediaRefs(joinFields(slots.front));
        const back = extractMediaRefs(joinFields(slots.back));
        const answer = extractMediaRefs(joinFields(slots.answer));

        const mediaFor = async (slot) => {
            const kind = MEDIA_SLOTS[slot];
            const raw = joinFields(slots[slot]);
            if (raw) {
                const refs = extractMediaRefs(raw);
                const explicit = (kind === 'img' ? refs.imgs : refs.snds)[0];
                if (explicit) return await resolve(explicit);
                const bare = htmlToMarkdown(refs.stripped).trim();
                if (bare && Object.values(ctx.mediaMap).includes(bare)) return await resolve(bare);
            }
            const side = slot.startsWith('front') ? front : back;
            const inline = (kind === 'img' ? side.imgs : side.snds)[0];
            return inline ? await resolve(inline) : null;
        };

        const media = {
            front_img: await mediaFor('front_img'),
            front_sound: await mediaFor('front_sound'),
            back_img: await mediaFor('back_img'),
            back_sound: await mediaFor('back_sound'),
        };

        if (cardType === 'cloze') {
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
        const backText = htmlToMarkdown(back.stripped);

        if (cardType === 'type_answer') {
            const answerText = htmlToMarkdown(answer.stripped);
            return answerText
                ? { cardType, name: deriveCardName(frontText), frontText, backText, answerText, media }
                : { cardType, name: deriveCardName(frontText), frontText, backText: '', answerText: backText, media };
        }

        return {
            cardType,
            name: deriveCardName(frontText),
            frontText,
            backText,
            media,
        };
    }

    /**
     * Imports an Anki .apkg into standalone decks.
     *
     * @param {Buffer|null} fileBuffer - raw package bytes; may be null when `sessionId` is given
     * @param {string} targetRelPath - accepted for signature parity with the other importers and deliberately ignored: Anki notes become standalone cards in decks, which have no location in the workspace tree
     * @param {object|null} mapping - `{ [notetypeId]: { cardType, slots } }`; the per-notetype suggestion is used for anything not covered
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

            const cardsByNote = new Map();
            for (const card of cards) {
                if (!cardsByNote.has(card.note_id)) cardsByNote.set(card.note_id, []);
                cardsByNote.get(card.note_id).push(card);
            }

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
                const allDecks = await this.query.getAllDecks();
                const existingDeck = allDecks.find(d => d.name === deckName);
                const deckHash = existingDeck
                    ? existingDeck.global_hash
                    : await this.decksService.createDeck(deckName, 'Imported from Anki package.');

                for (const primaryCard of primaryCards) {
                    const model = models[primaryCard.model_id] || { name: 'Basic', flds: [], tmpls: [] };
                    const content = await this._applyMapping(primaryCard, model, mappingFor(primaryCard.model_id, model), ctx);

                    const globalHash = await this.decksService.createStandaloneCard({
                        name: content.name,
                        cardType: content.cardType,
                        category: 'Concept',
                        customHtml: content.customHtml ?? null,
                        frontText: content.frontText,
                        backText: content.backText,
                        answerText: content.answerText ?? null,
                        media: content.media,
                    });

                    await this.decksService.addEntry(deckHash, { cardHash: globalHash });
                    imported++;

                    const cardInDb = await this.query.getFlashcardByHash(globalHash);
                    if (cardInDb) {
                        const reps = primaryCard.reps || 0;
                        const level = Math.min(5, Math.floor(reps / 3));
                        const easeFactor = primaryCard.factor
                            ? Math.min(3.0, Math.max(1.3, primaryCard.factor / 1000.0))
                            : 2.5;
                        await db.transaction(async () => {
                            await this.query.setFlashcardSrsState(cardInDb.id, level, reps, OWNER_SCOPE);
                            await this.query.insertReviewLog({
                                accountId: OWNER_SCOPE,
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
     * Streams one asset out of a live `analyze()` session, by its original Anki filename, decompressed.
     *
     * @returns {{ buffer: Buffer, filename: string }|null} null if the session or asset is gone
     */
    readSessionMedia(sessionId, name) {
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

    /** Reads back the package handle `analyze()` recorded for a session, so the apply phase reuses that extraction instead of asking for the file again. */
    _reopenSession(tempRoot) {
        const marker = path.join(tempRoot, SESSION_MARKER);
        if (!fs.existsSync(marker)) {
            throw new Error('Anki import session expired — please pick the file again.');
        }
        return JSON.parse(fs.readFileSync(marker, 'utf-8'));
    }

    /** Copies one media asset out of the package into the workspace, deduping by hash. */
    async _copyMedia(originalName, ctx) {
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

        const existing = await this.query.getMediaByHash(fileHash);
        if (existing) return { copiedName: existing.name, fileHash };

        const ext = path.extname(decodedName);
        const base = path.basename(decodedName, ext).replace(/[^\w.-]+/g, '_');
        const copiedName = `${base}-${crypto.randomUUID().slice(0, 8)}${ext}`;
        const destPath = path.join(mediaDirAbs, copiedName);

        fs.writeFileSync(destPath, fileBuf);
        await db.transaction(async () => {
            await this.query.insertMedia({
                hash: fileHash,
                name: copiedName,
                relativePath: path.join(mediaDirRel, copiedName),
                absolutePath: destPath,
            });
        })();

        return { copiedName, fileHash };
    }
}
