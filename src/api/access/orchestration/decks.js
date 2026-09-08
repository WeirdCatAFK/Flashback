import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import query from '../resources/query.js';
import db from '../primitives/database.js';
import { getWorkspacePath } from '../primitives/config.js';
import { sealEmitter } from '../../seal/seal.js';
import { withDocument } from '../resources/pathLock.js';
import { LATEST_VERSION } from '../../config/updates/registry.js';
import { OWNER_SCOPE, currentScope } from '../../requestContext.js';

const DECKS_DIR = '_decks';

/** Trimmed, de-duplicated, blank-free. The one definition of a clean tag list here. */
const cleanTagNames = (tags) => [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))];

export default class Decks {
    constructor() {
        this.query = query;
        this._ensureDecksDir();
    }

    /** Creates `_decks/` if it is missing. Filesystem only — safe from a constructor. */
    _ensureDecksDir() {
        const dir = this.decksPath;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    /** Where this vault's canonical deck JSON lives. */
    get decksPath() {
        return path.join(getWorkspacePath(), DECKS_DIR);
    }

    /** Per-vault setup: create `_decks/` and make sure the system deck's file exists. */
    async onVaultOpened() {
        this._ensureDecksDir();
        await this._ensureSystemDeckFile();
    }

    async _ensureSystemDeckFile() {
        const cols = await db.prepare("PRAGMA table_info(Decks)").all();
        if (!cols.find(c => c.name === 'is_system')) return;
        const systemDeck = await this.query.getSystemDeck();
        if (!systemDeck) return;
        await this._readOrRebuild(systemDeck.global_hash, systemDeck);
    }

    _filePath(globalHash) {
        return path.join(this.decksPath, `${globalHash}.json`);
    }

    _sealRelPath(globalHash) {
        return `${DECKS_DIR}/${globalHash}.json`;
    }

    /** Serializes one deck file's writes against every other writer of that deck. */
    _withDeckFile(globalHash, fn) {
        return withDocument(this._sealRelPath(globalHash), fn);
    }

    _read(globalHash) {
        return JSON.parse(fs.readFileSync(this._filePath(globalHash), 'utf-8'));
    }

    async _readOrRebuild(globalHash, deckRow) {
        try {
            return this._read(globalHash);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            const entries = (await this.query.getDeckEntries(deckRow.id, currentScope())).map((e) => {
                const entry = { cardHash: e.card_hash, documentPath: e.document_path };
                if (e.inline_card) {
                    try { entry.card = JSON.parse(e.inline_card); } catch { }
                }
                return entry;
            });
            const rebuilt = {
                formatVersion: LATEST_VERSION,
                globalHash,
                name: deckRow.name,
                description: deckRow.description ?? '',
                tags: deckRow.node_id ? await this.query.getDirectTagNames(deckRow.node_id) : [],
                isSystem: !!deckRow.is_system,
                created: deckRow.created_at ?? new Date().toISOString(),
                modified: new Date().toISOString(),
                entries,
            };
            this._write(globalHash, rebuilt);
            return rebuilt;
        }
    }

    _write(globalHash, data) {
        fs.writeFileSync(this._filePath(globalHash), JSON.stringify(data, null, 2));
    }

    _remove(globalHash) {
        const p = this._filePath(globalHash);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    /** Every deck with its entry count. */
    async listDecks() {
        return await this.query.getAllDecks();
    }

    /** Creates a deck and its canonical `_decks/<uuid>.json` file. */
    async createDeck(name, description = '') {
        const globalHash = crypto.randomUUID();
        return await this._withDeckFile(globalHash, () => this._createDeckLocked(globalHash, name, description));
    }

    async _createDeckLocked(globalHash, name, description) {
        const now = new Date().toISOString();
        const file = {
            formatVersion: LATEST_VERSION,
            globalHash, name, description, tags: [], created: now, modified: now, entries: [],
        };

        this._write(globalHash, file);
        try {
            await db.transaction(async () => {
                await this.query.insertDeck({ globalHash, name, description });
            })();
        } catch (err) {
            this._remove(globalHash);
            throw err;
        }
        await sealEmitter.create(this._sealRelPath(globalHash));
        return globalHash;
    }

    /** One deck's metadata. */
    async getDeck(globalHash) {
        const deck = await this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);
        const entries = await this.query.getDeckEntries(deck.id, currentScope());
        const tags = deck.node_id ? await this.query.getDirectTagNames(deck.node_id) : [];
        return { ...deck, entries, entry_count: entries.length, tags };
    }

    async _tagIdsForNames(tagNames) {
        const ids = [];
        for (const name of tagNames) {
            const tag = await this.query.getTagByName(name);
            if (tag) ids.push(tag.id);
        }
        return ids;
    }

    async _syncNodeTags(nodeId, tagNames) {
        const tagNodeIds = [];
        for (const name of tagNames) {
            let tag = await this.query.getTagByName(name);
            if (!tag) {
                const tNodeId = await this.query.createNode('Tag');
                await this.query.insertTag(name, tNodeId);
                tagNodeIds.push(tNodeId);
            } else {
                tagNodeIds.push(tag.node_id);
            }
        }
        await this.query.syncNodeTags(nodeId, tagNodeIds);
    }

    async _propagateTagsToCards(deck, tagNames) {
        if (!deck.node_id) return;
        const tagIds = await this._tagIdsForNames(tagNames);
        for (const e of await this.query.getDeckEntries(deck.id, currentScope())) {
            const cardNodeId = await this.query.getFlashcardNodeIdByHash(e.card_hash);
            if (cardNodeId) await this.query.setDeckConnectionInheritedTags(deck.node_id, cardNodeId, tagIds);
        }
    }

    /** Replaces a deck's tags, re-flowing them to its member cards. */
    async setTags(globalHash, tags) {
        return await this._withDeckFile(globalHash, () => this._setTagsLocked(globalHash, tags));
    }

    async _setTagsLocked(globalHash, tags) {
        const deck = await this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);
        const clean = cleanTagNames(tags);

        const file = await this._readOrRebuild(globalHash, deck);
        file.tags = clean;
        file.modified = new Date().toISOString();
        this._write(globalHash, file);

        await db.transaction(async () => {
            await this._syncNodeTags(deck.node_id, clean);
            await this._propagateTagsToCards(deck, clean);
        })();
        await sealEmitter.edit(this._sealRelPath(globalHash));
        return clean;
    }

    /** Updates a deck's name or description. */
    async updateDeck(globalHash, { name, description }) {
        return await this._withDeckFile(globalHash, () => this._updateDeckLocked(globalHash, { name, description }));
    }

    async _updateDeckLocked(globalHash, { name, description }) {
        const deck = await this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);

        const file = await this._readOrRebuild(globalHash, deck);
        if (name !== undefined) file.name = name;
        if (description !== undefined) file.description = description;
        file.modified = new Date().toISOString();

        this._write(globalHash, file);
        await db.transaction(async () => {
            await this.query.updateDeck(deck.id, {
                name: name ?? deck.name,
                description: description !== undefined ? description : deck.description,
            });
        })();
        await sealEmitter.edit(this._sealRelPath(globalHash));
    }

    /** Deletes a deck and its file, leaving its cards in place. */
    async deleteDeck(globalHash) {
        return await this._withDeckFile(globalHash, () => this._deleteDeckLocked(globalHash));
    }

    async _deleteDeckLocked(globalHash) {
        const deck = await this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);
        if (deck.is_system) throw new Error('Cannot delete the system deck');

        this._remove(globalHash);
        await db.transaction(async () => {
            if (deck.node_id) await this._syncNodeTags(deck.node_id, []);
            await this.query.deleteDeck(deck.id);
        })();
        await sealEmitter.delete(this._sealRelPath(globalHash));
    }

    /** Adds a card to a deck, in the file and the index. */
    async addEntry(deckHash, { cardHash, documentPath = null, inlineCard = null }) {
        return await this._withDeckFile(deckHash, () =>
            this._addEntryLocked(deckHash, { cardHash, documentPath, inlineCard }));
    }

    async _addEntryLocked(deckHash, { cardHash, documentPath, inlineCard }) {
        const deck = await this.query.getDeckByHash(deckHash);
        if (!deck) throw new Error(`Deck not found: ${deckHash}`);

        const existing = await this.query.getDeckEntryByCardHash(deck.id, cardHash);
        if (existing) throw new Error('Card already in deck');

        const position = await this.query.getDeckEntryCount(deck.id);

        const file = await this._readOrRebuild(deckHash, deck);
        const entry = { cardHash, documentPath };
        if (inlineCard) entry.card = inlineCard;
        file.entries.push(entry);
        file.modified = new Date().toISOString();

        this._write(deckHash, file);
        try {
            await db.transaction(async () => {
                await this.query.insertDeckEntry({
                    deckId: deck.id, cardHash, documentPath, position,
                    inlineCard: inlineCard ? JSON.stringify(inlineCard) : null,
                });
                if (deck.node_id) {
                    const cardNodeId = await this.query.getFlashcardNodeIdByHash(cardHash);
                    if (cardNodeId) {
                        await this.query.insertDeckConnection(deck.node_id, cardNodeId);
                        const tagIds = await this._tagIdsForNames(await this.query.getDirectTagNames(deck.node_id));
                        if (tagIds.length) await this.query.setDeckConnectionInheritedTags(deck.node_id, cardNodeId, tagIds);
                    }
                }
            })();
        } catch (err) {
            file.entries.pop();
            this._write(deckHash, file);
            throw err;
        }
        await sealEmitter.edit(this._sealRelPath(deckHash));
    }

    /** Removes a card from a deck, in the file and the index. */
    async removeEntry(deckHash, cardHash) {
        return await this._withDeckFile(deckHash, () => this._removeEntryLocked(deckHash, cardHash));
    }

    async _removeEntryLocked(deckHash, cardHash) {
        const deck = await this.query.getDeckByHash(deckHash);
        if (!deck) throw new Error(`Deck not found: ${deckHash}`);

        const file = await this._readOrRebuild(deckHash, deck);
        const before = [...file.entries];
        file.entries = file.entries.filter(e => e.cardHash !== cardHash);
        file.modified = new Date().toISOString();

        this._write(deckHash, file);
        try {
            await db.transaction(async () => {
                if (deck.node_id) {
                    const cardNodeId = await this.query.getFlashcardNodeIdByHash(cardHash);
                    if (cardNodeId) await this.query.deleteDeckConnection(deck.node_id, cardNodeId);
                }
                await this.query.deleteDeckEntry(deck.id, cardHash);
            })();
        } catch (err) {
            file.entries = before;
            this._write(deckHash, file);
            throw err;
        }
        await sealEmitter.edit(this._sealRelPath(deckHash));
    }

    /**
     * Describes what erasing a deck *and its cards* would destroy, so the caller can say so before doing it.
     *
     * @returns {{ total, standalone, documentAnchored, documents: string[], shared: number, otherDecks: string[] }}
     */
    async getContentsSummary(globalHash) {
        const deck = await this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);

        const entries = await this.query.getDeckEntries(deck.id, currentScope());
        const documents = new Set();
        const otherDecks = new Set();
        let standalone = 0;
        let documentAnchored = 0;
        let shared = 0;
        let sharedStandalone = 0;
        let sharedDocumentAnchored = 0;

        for (const entry of entries) {
            const documentPath = await this._cardDocumentPath(entry.card_hash);
            if (documentPath) {
                documentAnchored++;
                documents.add(documentPath);
            } else {
                standalone++;
            }

            const others = (await this.query.getDecksContainingCard(entry.card_hash))
                .filter(d => !d.is_system && d.id !== deck.id);
            if (others.length) {
                shared++;
                if (documentPath) sharedDocumentAnchored++; else sharedStandalone++;
                for (const d of others) otherDecks.add(d.name);
            }
        }

        return {
            deckName: deck.name,
            total: entries.length,
            standalone,
            documentAnchored,
            documents: [...documents],
            shared,
            sharedStandalone,
            sharedDocumentAnchored,
            otherDecks: [...otherDecks],
        };
    }

    /** Card hashes an erase would actually destroy, split by where they live so the caller can route each to the right deletion path. */
    async getPurgeTargets(globalHash, { includeShared = false } = {}) {
        const deck = await this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);

        const standalone = [];
        const anchored = [];
        let kept = 0;

        for (const entry of await this.query.getDeckEntries(deck.id, currentScope())) {
            const isShared = (await this.query.getDecksContainingCard(entry.card_hash))
                .some(d => !d.is_system && d.id !== deck.id);
            if (isShared && !includeShared) { kept++; continue; }

            const documentPath = await this._cardDocumentPath(entry.card_hash);
            if (documentPath) anchored.push({ hash: entry.card_hash, documentPath });
            else standalone.push(entry.card_hash);
        }

        return { standalone, anchored, kept };
    }

    /** A card's source document path, or null when it is standalone. */
    async _cardDocumentPath(cardHash) {
        return (await this.query.getFlashcardContentByHash(cardHash, OWNER_SCOPE))?.document_path ?? null;
    }

    /**
     * Unlinks a card from every deck that holds it — canonical JSON, DeckEntries row, and deck connection alike.
     *
     * @param {string} cardHash - globalHash of the card being destroyed.
     * @returns {Promise<number>} how many decks the card was removed from.
     */
    async removeCardEverywhere(cardHash) {
        const holders = await this.query.getDecksContainingCard(cardHash);
        for (const deck of holders) {
            await this.removeEntry(deck.global_hash, cardHash);
        }
        return holders.length;
    }

    /** The card browser: a filtered, sorted, paged view of every card in the vault. */
    async searchCards({ search, level = null, cardType = null, origin = null, flagged = false, flagKind = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}) {
        return await this.query.getAllFlashcards({ search, level, cardType, origin, flagged, flagKind, sortBy, sortDir, limit, offset }, currentScope());
    }

    /** How many cards match the card browser's current filters. */
    async getCardCount({ search, level = null, cardType = null, origin = null, flagged = false, flagKind = null } = {}) {
        return await this.query.getFlashcardCountFiltered({ search, level, cardType, origin, flagged, flagKind }, currentScope());
    }

    _standaloneSnapshot({ frontText, backText, answerText = null, name, cardType = 'basic', category = null, customHtml = null, media = null, origin = null, tags = null } = {}) {
        const cleanTags = cleanTagNames(tags);
        return {
            name: name ?? null,
            cardType,
            category,
            ...(origin ? { origin } : {}),
            ...(cleanTags.length ? { tags: cleanTags } : {}),
            vanillaData: {
                frontText: frontText || null,
                backText: backText || null,
                ...(cardType === 'type_answer' ? { answerText: answerText ?? '' } : {}),
                media: media || {},
            },
            customData: customHtml ? { html: customHtml } : null,
        };
    }

    /** Creates a card with no document, held by the system deck. */
    async createStandaloneCard({ frontText, backText, answerText = null, name, cardType = 'basic', category = null, customHtml = null, media = null, origin = null, tags = null } = {}) {
        const systemDeck = await this.query.getSystemDeck();
        if (!systemDeck) throw new Error('System deck not initialised — run migrations');
        return await this._withDeckFile(systemDeck.global_hash, () => this._createStandaloneCardLocked(
            systemDeck, { frontText, backText, answerText, name, cardType, category, customHtml, media, origin, tags }));
    }

    async _createStandaloneCardLocked(systemDeck, { frontText, backText, answerText, name, cardType, category, customHtml, media, origin, tags }) {
        if (category && !await this.query.getCategoryByName(category)) {
            throw new Error(`Unknown category: "${category}". Call GET /api/categories for valid values.`);
        }

        const globalHash = crypto.randomUUID();
        const snapshot = this._standaloneSnapshot({ frontText, backText, answerText, name, cardType, category, customHtml, media, origin, tags });

        await db.transaction(async () => {
            const nodeId = await this.query.createNode('Flashcard');
            await this.query.insertFlashcard({
                globalHash, nodeId, documentId: null,
                vanillaData: snapshot.vanillaData,
                customData: snapshot.customData,
                category, cardType, name, origin,
                level: 0, sm2Reps: 0, fileIndex: 0,
            }, OWNER_SCOPE);
            if (snapshot.tags) await this._syncNodeTags(nodeId, snapshot.tags);
            const position = await this.query.getDeckEntryCount(systemDeck.id);
            await this.query.insertDeckEntry({
                deckId: systemDeck.id, cardHash: globalHash,
                documentPath: null, position, inlineCard: JSON.stringify(snapshot),
            });
            if (systemDeck.node_id) {
                const cardNodeId = await this.query.getFlashcardNodeIdByHash(globalHash);
                if (cardNodeId) {
                    await this.query.insertDeckConnection(systemDeck.node_id, cardNodeId);
                    const tagIds = await this._tagIdsForNames(await this.query.getDirectTagNames(systemDeck.node_id));
                    if (tagIds.length) await this.query.setDeckConnectionInheritedTags(systemDeck.node_id, cardNodeId, tagIds);
                }
            }
        })();

        const file = await this._readOrRebuild(systemDeck.global_hash, systemDeck);
        file.entries.push({ cardHash: globalHash, documentPath: null, card: snapshot });
        file.modified = new Date().toISOString();
        this._write(systemDeck.global_hash, file);

        await sealEmitter.edit(this._sealRelPath(systemDeck.global_hash));
        return globalHash;
    }

    /** One card with its content, document path and media refs. */
    async getCard(hash) {
        const card = await this.query.getFlashcardContentByHash(hash, currentScope());
        if (!card) throw new Error(`Card not found: ${hash}`);
        return {
            globalHash: hash,
            name: card.name,
            cardType: card.card_type,
            level: card.level,
            origin: card.origin ?? null,
            frontText: card.frontText,
            backText: card.backText,
            answerText: card.answerText ?? null,
            customHtml: card.custom_html,
            category: card.category,
            documentPath: card.document_path ?? null,
            tags: card.node_id ? await this.query.getDirectTagNames(card.node_id) : [],
            media: {
                front_img: card.front_img ?? null,
                back_img: card.back_img ?? null,
                front_sound: card.front_sound ?? null,
                back_sound: card.back_sound ?? null,
            },
        };
    }

    /** Updates a card that lives in a deck file rather than a sidecar. */
    async updateStandaloneCard(hash, { frontText, backText, answerText, name, cardType, category, customHtml, tags } = {}) {
        const systemDeck = await this.query.getSystemDeck();
        const fields = { frontText, backText, answerText, name, cardType, category, customHtml, tags };
        if (!systemDeck) return await this._updateStandaloneCardLocked(hash, fields, null);
        return await this._withDeckFile(systemDeck.global_hash, () =>
            this._updateStandaloneCardLocked(hash, fields, systemDeck));
    }

    async _updateStandaloneCardLocked(hash, { frontText, backText, answerText, name, cardType, category, customHtml, tags }, systemDeck) {
        const card = await this.query.getFlashcardByHash(hash);
        if (!card) throw new Error(`Card not found: ${hash}`);
        if (card.document_id !== null && card.document_id !== undefined) {
            throw new Error('Card is linked to a document — edit from the document instead');
        }
        if (category && !await this.query.getCategoryByName(category)) {
            throw new Error(`Unknown category: "${category}". Call GET /api/categories for valid values.`);
        }
        const existing = await this.query.getFlashcardContentByHash(hash, OWNER_SCOPE);
        const merged = {
            frontText: frontText !== undefined ? frontText : existing.frontText,
            backText: backText !== undefined ? backText : existing.backText,
            answerText: answerText !== undefined ? answerText : existing.answerText,
            name: name !== undefined ? name : existing.name,
            cardType: cardType !== undefined ? cardType : existing.card_type,
            category: category !== undefined ? category : existing.category,
            customHtml: customHtml !== undefined ? customHtml : existing.custom_html,
            origin: existing.origin ?? null,
            tags: tags !== undefined ? cleanTagNames(tags) : await this.query.getDirectTagNames(existing.node_id),
            media: {
                front_img: existing.front_img || null,
                back_img: existing.back_img || null,
                front_sound: existing.front_sound || null,
                back_sound: existing.back_sound || null,
            },
        };
        const snapshot = this._standaloneSnapshot(merged);
        await db.transaction(async () => {
            await this.query.updateFlashcardContentByHash(hash, merged);
            if (tags !== undefined) await this._syncNodeTags(existing.node_id, merged.tags);
            if (systemDeck) await this.query.updateDeckEntryInlineCard(systemDeck.id, hash, JSON.stringify(snapshot));
        })();

        if (systemDeck) {
            try {
                const file = await this._readOrRebuild(systemDeck.global_hash, systemDeck);
                const entry = file.entries.find(e => e.cardHash === hash);
                if (entry) {
                    entry.card = snapshot;
                    file.modified = new Date().toISOString();
                    this._write(systemDeck.global_hash, file);
                }
            } catch { }
            await sealEmitter.edit(this._sealRelPath(systemDeck.global_hash));
        }
    }

    /** Deletes a standalone card and unlinks it from every deck. */
    async deleteStandaloneCard(hash) {
        const systemDeck = await this.query.getSystemDeck();
        if (!systemDeck) return await this._deleteStandaloneCardLocked(hash, null);
        return await this._withDeckFile(systemDeck.global_hash, () =>
            this._deleteStandaloneCardLocked(hash, systemDeck));
    }

    async _deleteStandaloneCardLocked(hash, systemDeck) {
        const card = await this.query.getFlashcardByHash(hash);
        if (!card) throw new Error(`Card not found: ${hash}`);
        if (card.document_id !== null && card.document_id !== undefined) {
            throw new Error('Card is linked to a document — delete from the document instead');
        }

        await db.transaction(async () => {
            await this.query.deleteFlashcardDeckEntries(hash);
            await this.query.deleteFlashcard(card.id);
        })();

        if (systemDeck) {
            try {
                const file = this._read(systemDeck.global_hash);
                file.entries = file.entries.filter(e => e.cardHash !== hash);
                file.modified = new Date().toISOString();
                this._write(systemDeck.global_hash, file);
            } catch { }
            await sealEmitter.edit(this._sealRelPath(systemDeck.global_hash));
        }
    }

    /**
     * Enumerates and parses every canonical deck file in _decks/.
     *
     * @returns {Array<{ globalHash: string, data: object|null }>} data is null for malformed JSON.
     */
    async listDeckFiles() {
        if (!fs.existsSync(this.decksPath)) return [];
        return await fs.readdirSync(this.decksPath)
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const globalHash = path.basename(f, '.json');
                try {
                    return { globalHash, data: this._read(globalHash) };
                } catch {
                    return { globalHash, data: null };
                }
            });
    }

    /**
     * Applies `transform` to every canonical deck file, rewriting the ones it changed and re-syncing their `DeckEntries.inline_card` mirrors.
     *
     * @param {(deckFile: object) => boolean} transform mutates the file in place; returns true when it changed something.
     * @returns {{ filesRewritten: number, corruptFiles: string[], failed: Array<{hash: string, error: string}> }}
     */
    async mapDeckFiles(transform) {
        const result = { filesRewritten: 0, corruptFiles: [], failed: [] };

        for (const { globalHash, data } of await this.listDeckFiles()) {
            if (!data) { result.corruptFiles.push(globalHash); continue; }

            let changed = false;
            try {
                changed = transform(data) === true;
            } catch (err) {
                result.failed.push({ hash: globalHash, error: err.message });
                continue;
            }
            if (!changed) continue;

            data.modified = new Date().toISOString();
            this._write(globalHash, data);

            const deck = await this.query.getDeckByHash(globalHash);
            if (deck) {
                await db.transaction(async () => {
                    for (const entry of data.entries ?? []) {
                        if (!entry?.card) continue;
                        await this.query.updateDeckEntryInlineCard(deck.id, entry.cardHash, JSON.stringify(entry.card));
                    }
                })();
            }
            result.filesRewritten++;
        }

        return result;
    }

    /**
     * Compares _decks/*.json files against the Decks/DeckEntries tables.
     *
     * @returns {{ fileWithoutDb: string[], dbWithoutFile: string[], corruptFiles: string[], entryMismatches: Array<{ deckHash, missingInDb: string[], missingInFile: string[] }>, danglingEntries: Array<{ deckHash, cardHash }> }}
     */
    async diagnoseDecks() {
        const files = await this.listDeckFiles();
        const dbDecks = await this.query.getAllDecks();
        const fileByHash = new Map(files.map(f => [f.globalHash, f]));
        const dbByHash = new Map(dbDecks.map(d => [d.global_hash, d]));

        const fileWithoutDb = [];
        const dbWithoutFile = [];
        const corruptFiles = [];
        const entryMismatches = [];
        const danglingEntries = [];

        for (const f of files) {
            if (f.data === null) { corruptFiles.push(f.globalHash); continue; }
            if (!dbByHash.has(f.globalHash)) fileWithoutDb.push(f.globalHash);
        }
        for (const d of dbDecks) {
            if (!fileByHash.has(d.global_hash)) { dbWithoutFile.push(d.global_hash); continue; }

            const f = fileByHash.get(d.global_hash);
            if (f.data === null) continue;
            const fileHashes = new Set((f.data.entries ?? []).map(e => e.cardHash));
            const dbEntries = await this.query.getDeckEntries(d.id, currentScope());
            const dbHashes = new Set(dbEntries.map(e => e.card_hash));

            const missingInDb = [...fileHashes].filter(h => !dbHashes.has(h));
            const missingInFile = [...dbHashes].filter(h => !fileHashes.has(h));
            if (missingInDb.length || missingInFile.length) {
                entryMismatches.push({ deckHash: d.global_hash, missingInDb, missingInFile });
            }
            for (const e of dbEntries) {
                if (!await this.query.getFlashcardByHash(e.card_hash)) {
                    danglingEntries.push({ deckHash: d.global_hash, cardHash: e.card_hash });
                }
            }
        }
        return { fileWithoutDb, dbWithoutFile, corruptFiles, entryMismatches, danglingEntries };
    }

    async _importDeckFile(globalHash, data) {
        await db.transaction(async () => {
            const isSystem = data.isSystem && !await this.query.getSystemDeck() ? 1 : 0;
            const deckId = await this.query.insertDeck({
                globalHash,
                name: data.name ?? 'Recovered deck',
                description: data.description ?? '',
                isSystem,
            });
            const deck = await this.query.getDeckByHash(globalHash);
            for (const [i, e] of (data.entries ?? []).entries()) {
                await this.query.insertDeckEntry({
                    deckId, cardHash: e.cardHash,
                    documentPath: e.documentPath ?? null,
                    position: i,
                    inlineCard: e.card ? JSON.stringify(e.card) : null,
                });
                if (deck.node_id) {
                    const cardNodeId = await this.query.getFlashcardNodeIdByHash(e.cardHash);
                    if (cardNodeId) await this.query.insertDeckConnection(deck.node_id, cardNodeId);
                }
            }
            if (Array.isArray(data.tags) && data.tags.length && deck.node_id) {
                await this._syncNodeTags(deck.node_id, data.tags);
            }
        })();
    }

    async _propagateAllDeckTags() {
        await db.transaction(async () => {
            for (const deck of await this.query.getAllDecks()) {
                const tags = deck.node_id ? await this.query.getDirectTagNames(deck.node_id) : [];
                if (tags.length) await this._propagateTagsToCards(deck, tags);
            }
        })();
    }

    /**
     * Applies deck diagnosis: files without DB rows are imported, DB rows without files self-heal via `_readOrRebuild`.
     *
     * @returns {{ decksImported: number, deckFilesRebuilt: number, entriesAdded: number, entriesRemoved: number }}
     */
    async repairFromFiles() {
        const diag = await this.diagnoseDecks();
        const actions = { decksImported: 0, deckFilesRebuilt: 0, entriesAdded: 0, entriesRemoved: 0 };

        for (const hash of diag.fileWithoutDb) {
            await this._importDeckFile(hash, this._read(hash));
            actions.decksImported++;
        }
        for (const hash of diag.dbWithoutFile) {
            await this._readOrRebuild(hash, await this.query.getDeckByHash(hash));
            actions.deckFilesRebuilt++;
        }
        for (const mm of diag.entryMismatches) {
            const deck = await this.query.getDeckByHash(mm.deckHash);
            const data = this._read(mm.deckHash);
            await db.transaction(async () => {
                for (const h of mm.missingInDb) {
                    const entry = (data.entries ?? []).find(e => e.cardHash === h);
                    await this.query.insertDeckEntry({
                        deckId: deck.id, cardHash: h,
                        documentPath: entry?.documentPath ?? null,
                        position: await this.query.getDeckEntryCount(deck.id),
                        inlineCard: entry?.card ? JSON.stringify(entry.card) : null,
                    });
                    if (deck.node_id) {
                        const cardNodeId = await this.query.getFlashcardNodeIdByHash(h);
                        if (cardNodeId) await this.query.insertDeckConnection(deck.node_id, cardNodeId);
                    }
                    actions.entriesAdded++;
                }
                for (const h of mm.missingInFile) {
                    if (deck.node_id) {
                        const cardNodeId = await this.query.getFlashcardNodeIdByHash(h);
                        if (cardNodeId) await this.query.deleteDeckConnection(deck.node_id, cardNodeId);
                    }
                    await this.query.deleteDeckEntry(deck.id, h);
                    actions.entriesRemoved++;
                }
            })();
        }
        await this._propagateAllDeckTags();
        return actions;
    }

    /**
     * Full _decks/*.json → DB import for the Doctor's rebuild path.
     *
     * @returns {{ decks: number, restoredCards: number, warnings: string[] }}
     */
    async rebuildFromFiles() {
        const warnings = [];
        let decksImported = 0;
        let restoredCards = 0;

        for (const f of await this.listDeckFiles()) {
            if (f.data === null) {
                warnings.push(`Corrupt deck file skipped: _decks/${f.globalHash}.json`);
                continue;
            }
            try {
                await this._importDeckFile(f.globalHash, f.data);
                decksImported++;
            } catch (err) {
                warnings.push(`Failed to import deck ${f.globalHash}: ${err.message}`);
                continue;
            }

            for (const e of f.data.entries ?? []) {
                if (!e.card || e.documentPath || await this.query.getFlashcardByHash(e.cardHash)) continue;
                try {
                    await db.transaction(async () => {
                        const nodeId = await this.query.createNode('Flashcard');
                        await this.query.insertFlashcard({
                            globalHash: e.cardHash, nodeId, documentId: null,
                            vanillaData: e.card.vanillaData ?? null,
                            customData: e.card.customData ?? null,
                            category: e.card.category ?? null,
                            cardType: e.card.cardType ?? 'basic',
                            name: e.card.name ?? null,
                            origin: e.card.origin ?? null,
                            level: 0, sm2Reps: 0, fileIndex: 0,
                        }, OWNER_SCOPE);
                        if (e.card.tags?.length) await this._syncNodeTags(nodeId, e.card.tags);
                        const deck = await this.query.getDeckByHash(f.globalHash);
                        if (deck?.node_id) {
                            const cardNodeId = await this.query.getFlashcardNodeIdByHash(e.cardHash);
                            if (cardNodeId) await this.query.insertDeckConnection(deck.node_id, cardNodeId);
                        }
                    })();
                    restoredCards++;
                } catch (err) {
                    warnings.push(`Failed to restore standalone card ${e.cardHash}: ${err.message}`);
                }
            }
        }

        if (!await this.query.getSystemDeck()) {
            const globalHash = crypto.randomUUID();
            await this.query.insertDeck({ globalHash, name: 'Cards', description: '', isSystem: 1 });
            await this._readOrRebuild(globalHash, await this.query.getDeckByHash(globalHash));
            warnings.push('System deck file was missing — recreated empty.');
            decksImported++;
        }

        await this._propagateAllDeckTags();

        return { decks: decksImported, restoredCards, warnings };
    }
}
