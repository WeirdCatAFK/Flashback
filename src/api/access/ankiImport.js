/**
 * ankiImport.js
 * Orchestrator to parse and import Anki .apkg packages into Flashback.
 */

import BetterSQLite from 'better-sqlite3';
import AdmZip from 'adm-zip';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Files from './files.js';
import query from './query.js';
import db from './Database.js';
import Decks from './decks.js';

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

    /**
     * Detects whether the collection uses the newer anki21b table format (Anki ≥ 2.1.50)
     * or the legacy col.models JSON format, and returns unified { decks, models } metadata.
     */
    _loadAnkiMetadata(ankiDb) {
        const hasNotetypes = ankiDb.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='notetypes'"
        ).get();

        if (hasNotetypes) {
            // Newer anki21b format: separate notetypes / templates / fields / decks tables
            const decks = {};
            ankiDb.prepare("SELECT id, name FROM decks").all()
                .forEach(d => { decks[d.id] = { name: d.name }; });

            const models = {};
            ankiDb.prepare("SELECT id, name, kind FROM notetypes").all()
                .forEach(nt => {
                    const flds = ankiDb.prepare(
                        "SELECT ord, name FROM fields WHERE ntid = ? ORDER BY ord"
                    ).all(nt.id);
                    // templates.config is a protobuf blob — only name/ord are readable here
                    const tmpls = ankiDb.prepare(
                        "SELECT ord, name FROM templates WHERE ntid = ? ORDER BY ord"
                    ).all(nt.id);
                    models[nt.id] = { name: nt.name, type: nt.kind, flds, tmpls };
                });
            return { decks, models };
        }

        // Legacy format: col.models and col.decks are JSON strings
        const colRow = ankiDb.prepare("SELECT decks, models FROM col LIMIT 1").get();
        if (!colRow) throw new Error("Invalid Anki collection database: 'col' table is empty.");
        return {
            decks: JSON.parse(colRow.decks),
            models: JSON.parse(colRow.models),
        };
    }

    /**
     * Uses the card's template ordinal (cards.ord) to extract the correct front/back
     * content from the note's fields, based on the model's template qfmt/afmt.
     * Falls back to positional fields[0]/fields[1] when template data is unavailable
     * (e.g. newer format where qfmt is inside a protobuf blob we can't parse).
     */
    _extractCardContent(primaryCard, model) {
        const noteFields = primaryCard.note_fields.split('\x1f');

        // Build field-name → value map
        const fieldMap = {};
        (model.flds || []).forEach(f => {
            fieldMap[f.name] = noteFields[f.ord] ?? '';
        });

        const tmpls = model.tmpls || [];
        const tmpl = tmpls[primaryCard.card_ord] ?? tmpls[0] ?? {};
        const qfmt = tmpl.qfmt || '';
        const afmt = tmpl.afmt || '';

        // Substitute {{FieldName}}, stripping conditionals and the type:/cloze:/hint:
        // modifier prefixes Anki templates use (e.g. the default cloze template is
        // literally "{{cloze:Text}}" — without stripping "cloze:" here, "cloze:Text"
        // is looked up as a field name, misses, and the field's real content
        // (including the {{c1::...}} markers) is silently dropped).
        const renderFmt = (fmt) =>
            fmt.replace(/\{\{(?:[#/^])?(?:type:|cloze:|hint:)?([^/{}#^]+)\}\}/g, (_, name) => {
                return fieldMap[name.trim()] ?? '';
            }).replace(/\{\{FrontSide\}\}/g, '').trim();

        let frontText, backText;

        if (qfmt && /\{\{type:/i.test(qfmt)) {
            // type_answer: separate the visible question from the expected answer field
            const typeMatch = qfmt.match(/\{\{type:([^}]+)\}\}/i);
            const answerFieldName = typeMatch ? typeMatch[1].trim() : null;
            const qfmtNoType = qfmt.replace(/\{\{type:[^}]+\}\}/gi, '').trim();
            frontText = renderFmt(qfmtNoType) || noteFields[0] || '';
            backText = answerFieldName
                ? (fieldMap[answerFieldName] ?? noteFields[1] ?? '')
                : (noteFields[1] || '');
        } else {
            frontText = renderFmt(qfmt) || noteFields[0] || '';
            backText = renderFmt(afmt) || noteFields[1] || '';
        }

        return { frontText, backText, qfmt };
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
     * Imports an Anki .apkg file buffer into the workspace.
     * @param {Buffer} fileBuffer
     * @param {string} targetRelPath
     * @returns {Promise<{ ok: boolean, path: string }>}
     */
    async importApkg(fileBuffer, targetRelPath = "") {
        console.log(`Importing Anki package into standalone decks`);
        const tempId = crypto.randomUUID();
        const tempRoot = path.join(os.tmpdir(), 'flashback_anki_imports', tempId);
        const tempApkgPath = path.join(tempRoot, 'deck.apkg');

        fs.mkdirSync(tempRoot, { recursive: true });
        fs.writeFileSync(tempApkgPath, fileBuffer);

        try {
            const zip = new AdmZip(tempApkgPath);
            zip.extractAllTo(tempRoot, true);

            // Find the collection DB (try anki21b first, then anki21, then anki2)
            let dbFile = 'collection.anki21b';
            if (!fs.existsSync(path.join(tempRoot, dbFile))) dbFile = 'collection.anki21';
            if (!fs.existsSync(path.join(tempRoot, dbFile))) dbFile = 'collection.anki2';
            if (!fs.existsSync(path.join(tempRoot, dbFile))) {
                const found = fs.readdirSync(tempRoot)
                    .find(f => f.endsWith('.anki2') || f.endsWith('.anki21') || f.endsWith('.anki21b') || f.includes('collection'));
                if (found) dbFile = found;
                else throw new Error("Could not find collection SQLite database in Anki package.");
            }

            const ankiDb = new BetterSQLite(path.join(tempRoot, dbFile));

            // Media map: numeric key → original filename
            let mediaMap = {};
            const mediaMapPath = path.join(tempRoot, 'media');
            if (fs.existsSync(mediaMapPath)) {
                try { mediaMap = JSON.parse(fs.readFileSync(mediaMapPath, 'utf-8')); }
                catch (e) { console.warn("Failed to parse Anki media map:", e); }
            }

            const { decks, models } = this._loadAnkiMetadata(ankiDb);

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

            for (const [deckName, primaryCards] of notesByDeck.entries()) {
                const allDecks = this.query.getAllDecks();
                const existingDeck = allDecks.find(d => d.name === deckName);
                const deckHash = existingDeck
                    ? existingDeck.global_hash
                    : this.decksService.createDeck(deckName, 'Imported from Anki package.');

                for (let idx = 0; idx < primaryCards.length; idx++) {
                    const primaryCard = primaryCards[idx];
                    const model = models[primaryCard.model_id] || { name: 'Basic', flds: [], tmpls: [] };
                    const { frontText, backText, qfmt } = this._extractCardContent(primaryCard, model);
                    const cardType = this._detectCardType(model, qfmt);

                    // Extract and copy any embedded media from both sides
                    const processMediaRef = (text) => {
                        let cleanedText = text;
                        const mediaRefs = { img: null, snd: null };

                        for (const match of [...text.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/g)]) {
                            const copied = this._copyMedia(match[1], mediaMap, tempRoot, mediaDirAbs, 'media');
                            if (copied) { mediaRefs.img = copied.fileHash; cleanedText = cleanedText.replace(match[0], ''); }
                        }
                        for (const match of [...text.matchAll(/\[sound:([^\]]+)\]/g)]) {
                            const copied = this._copyMedia(match[1], mediaMap, tempRoot, mediaDirAbs, 'media');
                            if (copied) { mediaRefs.snd = copied.fileHash; cleanedText = cleanedText.replace(match[0], ''); }
                        }
                        for (const match of [...text.matchAll(/<(?:audio|source|embed)[^>]+src=["']([^"']+)["'][^>]*>/g)]) {
                            const copied = this._copyMedia(match[1], mediaMap, tempRoot, mediaDirAbs, 'media');
                            if (copied) { mediaRefs.snd = copied.fileHash; cleanedText = cleanedText.replace(match[0], ''); }
                        }
                        return { text: cleanedText, mediaRefs };
                    };

                    let globalHash;

                    if (cardType === 'custom') {
                        // Image Occlusion and other rich-HTML types: store raw HTML verbatim
                        processMediaRef(frontText); // copy media even if we can't inline it
                        globalHash = this.decksService.createStandaloneCard({
                            name: deriveCardName(htmlToMarkdown(frontText), 'Custom card'),
                            cardType: 'custom',
                            category: 'Concept',
                            customHtml: frontText,
                        });
                    } else if (cardType === 'cloze') {
                        // Normalise Anki cloze syntax {{c1::answer::hint}} → {{answer}}
                        const clozeText = frontText.replace(/{{c\d+::([^:}]+)(?:::[^}]*)?}}/g, '{{$1}}');
                        const frontRes = processMediaRef(clozeText);
                        const cleanCloze = htmlToMarkdown(frontRes.text);
                        globalHash = this.decksService.createStandaloneCard({
                            name: deriveCardName(cleanCloze.replace(/\{\{([^}]+)\}\}/g, '$1')),
                            cardType: 'cloze',
                            category: 'Concept',
                            frontText: cleanCloze,
                            backText: cleanCloze,
                            media: { front_img: frontRes.mediaRefs.img, front_sound: frontRes.mediaRefs.snd },
                        });
                    } else {
                        // basic, reversible, type_answer — all share the same vanillaData shape
                        const frontRes = processMediaRef(frontText);
                        const backRes = processMediaRef(backText);
                        const cleanFront = htmlToMarkdown(frontRes.text);
                        globalHash = this.decksService.createStandaloneCard({
                            name: deriveCardName(cleanFront),
                            cardType,
                            category: 'Concept',
                            frontText: cleanFront,
                            backText: htmlToMarkdown(backRes.text),
                            media: {
                                front_img: frontRes.mediaRefs.img,
                                back_img: backRes.mediaRefs.img,
                                front_sound: frontRes.mediaRefs.snd,
                                back_sound: backRes.mediaRefs.snd,
                            },
                        });
                    }

                    this.decksService.addEntry(deckHash, { cardHash: globalHash });

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

            ankiDb.close();
            return { ok: true, path: importFolderName };
        } catch (e) {
            console.error("Anki import failed:", e);
            throw e;
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    }

    _copyMedia(originalName, mediaMap, tempRoot, destDirAbs, destDirRel) {
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

        const srcPath = path.join(tempRoot, mediaKey);
        if (!fs.existsSync(srcPath)) return null;

        const fileBuf = fs.readFileSync(srcPath);
        const fileHash = crypto.createHash('sha256').update(fileBuf).digest('hex');

        const existing = this.query.getMediaByHash(fileHash);
        if (existing) return { copiedName: existing.name, fileHash };

        const ext = path.extname(decodedName);
        const base = path.basename(decodedName, ext).replace(/[^\w.-]+/g, '_');
        const copiedName = `${base}-${crypto.randomUUID().slice(0, 8)}${ext}`;
        const destPath = path.join(destDirAbs, copiedName);

        fs.copyFileSync(srcPath, destPath);
        db.transaction(() => {
            this.query.insertMedia({
                hash: fileHash,
                name: copiedName,
                relativePath: path.join(destDirRel, copiedName),
                absolutePath: destPath,
            });
        })();

        return { copiedName, fileHash };
    }
}
