import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import query from './query.js';
import db from './Database.js';
import { getWorkspacePath } from './Config.js';
import { sealEmitter } from '../seal/seal.js';

const DECKS_DIR = '_decks';

export default class Decks {
    constructor() {
        this.query = query;
        this.decksPath = path.join(getWorkspacePath(), DECKS_DIR);
        if (!fs.existsSync(this.decksPath)) {
            fs.mkdirSync(this.decksPath, { recursive: true });
        }
        this._ensureSystemDeckFile();
    }

    _ensureSystemDeckFile() {
        const cols = db.prepare("PRAGMA table_info(Decks)").all();
        if (!cols.find(c => c.name === 'is_system')) return;
        const systemDeck = this.query.getSystemDeck();
        if (!systemDeck) return;
        // _readOrRebuild both ensures the file exists AND recovers any DeckEntries
        // the DB still knows about, instead of always starting from an empty deck.
        this._readOrRebuild(systemDeck.global_hash, systemDeck);
    }

    _filePath(globalHash) {
        return path.join(this.decksPath, `${globalHash}.json`);
    }

    // Workspace-relative path to a deck's canonical JSON, used as the Seal commit
    // label. Always forward-slashed (normPath in seal.js would convert it anyway,
    // but keeping it canonical here matches the `<action>: <path>` messages that
    // documents.js emits for sidecars).
    _sealRelPath(globalHash) {
        return `${DECKS_DIR}/${globalHash}.json`;
    }

    _read(globalHash) {
        return JSON.parse(fs.readFileSync(this._filePath(globalHash), 'utf-8'));
    }

    // Reads a deck's canonical JSON, rebuilding it from the DB if the file is
    // unexpectedly missing (e.g. deleted out-of-band). Seal versions deck writes,
    // but a live desync still needs an immediate recovery source, and the
    // DeckEntries table is the next-best truth. This turns a desync into a
    // self-heal instead of a raw fs crash reaching the caller.
    _readOrRebuild(globalHash, deckRow) {
        try {
            return this._read(globalHash);
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            const entries = this.query.getDeckEntries(deckRow.id).map((e) => {
                const entry = { cardHash: e.card_hash, documentPath: e.document_path };
                if (e.inline_card) {
                    try { entry.card = JSON.parse(e.inline_card); } catch { /* ignore malformed snapshot */ }
                }
                return entry;
            });
            const rebuilt = {
                globalHash,
                name: deckRow.name,
                description: deckRow.description ?? '',
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

    listDecks() {
        return this.query.getAllDecks();
    }

    async createDeck(name, description = '') {
        const globalHash = crypto.randomUUID();
        const now = new Date().toISOString();
        const file = { globalHash, name, description, created: now, modified: now, entries: [] };

        this._write(globalHash, file);
        try {
            db.transaction(() => {
                this.query.insertDeck({ globalHash, name, description });
            })();
        } catch (err) {
            this._remove(globalHash);
            throw err;
        }
        // A new deck file is a structural op: create() flushes any pending debounced
        // edits first so commit order stays chronological.
        await sealEmitter.create(this._sealRelPath(globalHash));
        return globalHash;
    }

    getDeck(globalHash) {
        const deck = this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);
        const entries = this.query.getDeckEntries(deck.id);
        return { ...deck, entries, entry_count: entries.length };
    }

    async updateDeck(globalHash, { name, description }) {
        const deck = this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);

        this._ensureSystemDeckFile();
        const file = this._readOrRebuild(globalHash, deck);
        if (name !== undefined) file.name = name;
        if (description !== undefined) file.description = description;
        file.modified = new Date().toISOString();

        this._write(globalHash, file);
        db.transaction(() => {
            this.query.updateDeck(deck.id, {
                name: name ?? deck.name,
                description: description !== undefined ? description : deck.description,
            });
        })();
        await sealEmitter.edit(this._sealRelPath(globalHash));
    }

    async deleteDeck(globalHash) {
        const deck = this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);
        if (deck.is_system) throw new Error('Cannot delete the system deck');

        this._remove(globalHash);
        db.transaction(() => {
            this.query.deleteDeck(deck.id);
        })();
        await sealEmitter.delete(this._sealRelPath(globalHash));
    }

    async addEntry(deckHash, { cardHash, documentPath = null, inlineCard = null }) {
        const deck = this.query.getDeckByHash(deckHash);
        if (!deck) throw new Error(`Deck not found: ${deckHash}`);

        const existing = this.query.getDeckEntryByCardHash(deck.id, cardHash);
        if (existing) throw new Error('Card already in deck');

        const position = this.query.getDeckEntryCount(deck.id);

        const file = this._readOrRebuild(deckHash, deck);
        const entry = { cardHash, documentPath };
        if (inlineCard) entry.card = inlineCard;
        file.entries.push(entry);
        file.modified = new Date().toISOString();

        this._write(deckHash, file);
        try {
            db.transaction(() => {
                this.query.insertDeckEntry({
                    deckId: deck.id, cardHash, documentPath, position,
                    inlineCard: inlineCard ? JSON.stringify(inlineCard) : null,
                });
                if (deck.node_id) {
                    const cardNodeId = this.query.getFlashcardNodeIdByHash(cardHash);
                    if (cardNodeId) this.query.insertDeckConnection(deck.node_id, cardNodeId);
                }
            })();
        } catch (err) {
            file.entries.pop();
            this._write(deckHash, file);
            throw err;
        }
        // Debounced edit — a bulk import that adds many cards to one deck batches
        // into a single commit rather than one per card (see #3).
        await sealEmitter.edit(this._sealRelPath(deckHash));
    }

    async removeEntry(deckHash, cardHash) {
        const deck = this.query.getDeckByHash(deckHash);
        if (!deck) throw new Error(`Deck not found: ${deckHash}`);

        const file = this._readOrRebuild(deckHash, deck);
        const before = [...file.entries];
        file.entries = file.entries.filter(e => e.cardHash !== cardHash);
        file.modified = new Date().toISOString();

        this._write(deckHash, file);
        try {
            db.transaction(() => {
                if (deck.node_id) {
                    const cardNodeId = this.query.getFlashcardNodeIdByHash(cardHash);
                    if (cardNodeId) this.query.deleteDeckConnection(deck.node_id, cardNodeId);
                }
                this.query.deleteDeckEntry(deck.id, cardHash);
            })();
        } catch (err) {
            file.entries = before;
            this._write(deckHash, file);
            throw err;
        }
        await sealEmitter.edit(this._sealRelPath(deckHash));
    }

    searchCards({ search, level = null, cardType = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}) {
        return this.query.getAllFlashcards({ search, level, cardType, sortBy, sortDir, limit, offset });
    }

    getCardCount({ search, level = null, cardType = null } = {}) {
        return this.query.getFlashcardCountFiltered({ search, level, cardType });
    }

    // Builds the canonical content snapshot stored alongside a standalone card's
    // deck entry (file entry.card + DeckEntries.inline_card). Standalone cards
    // have no document sidecar, so this snapshot is their only canonical-layer
    // representation — without it they'd be unrecoverable after a DB rebuild.
    _standaloneSnapshot({ frontText, backText, name, cardType = 'basic', category = null, customHtml = null, media = null } = {}) {
        return {
            name: name ?? null,
            cardType,
            category,
            vanillaData: {
                frontText: frontText || null,
                backText: backText || null,
                media: media || {},
            },
            customData: customHtml ? { html: customHtml } : null,
        };
    }

    async createStandaloneCard({ frontText, backText, name, cardType = 'basic', category = null, customHtml = null, media = null } = {}) {
        const systemDeck = this.query.getSystemDeck();
        if (!systemDeck) throw new Error('System deck not initialised — run migrations');
        if (category && !this.query.getCategoryByName(category)) {
            throw new Error(`Unknown category: "${category}". Call GET /api/categories for valid values.`);
        }

        const globalHash = crypto.randomUUID();
        const snapshot = this._standaloneSnapshot({ frontText, backText, name, cardType, category, customHtml, media });

        db.transaction(() => {
            const nodeId = this.query.createNode('Flashcard');
            this.query.insertFlashcard({
                globalHash, nodeId, documentId: null,
                vanillaData: snapshot.vanillaData,
                customData: snapshot.customData,
                category, cardType, name,
                level: 0, sm2Reps: 0, fileIndex: 0,
            });
            const position = this.query.getDeckEntryCount(systemDeck.id);
            this.query.insertDeckEntry({
                deckId: systemDeck.id, cardHash: globalHash,
                documentPath: null, position, inlineCard: JSON.stringify(snapshot),
            });
            if (systemDeck.node_id) {
                const cardNodeId = this.query.getFlashcardNodeIdByHash(globalHash);
                if (cardNodeId) this.query.insertDeckConnection(systemDeck.node_id, cardNodeId);
            }
        })();

        this._ensureSystemDeckFile();
        const file = this._read(systemDeck.global_hash);
        file.entries.push({ cardHash: globalHash, documentPath: null, card: snapshot });
        file.modified = new Date().toISOString();
        this._write(systemDeck.global_hash, file);

        // Editing the system deck's file. Debounced so a bulk standalone-card
        // import (e.g. an MCP-driven batch) collapses into one commit (see #3).
        await sealEmitter.edit(this._sealRelPath(systemDeck.global_hash));
        return globalHash;
    }

    async updateStandaloneCard(hash, { frontText, backText, name, cardType, category } = {}) {
        const card = this.query.getFlashcardByHash(hash);
        if (!card) throw new Error(`Card not found: ${hash}`);
        if (card.document_id !== null && card.document_id !== undefined) {
            throw new Error('Card is linked to a document — edit from the document instead');
        }
        if (category && !this.query.getCategoryByName(category)) {
            throw new Error(`Unknown category: "${category}". Call GET /api/categories for valid values.`);
        }
        const snapshot = this._standaloneSnapshot({ frontText, backText, name, cardType, category });
        const systemDeck = this.query.getSystemDeck();
        db.transaction(() => {
            this.query.updateFlashcardContentByHash(hash, { frontText, backText, name, cardType, category });
            if (systemDeck) this.query.updateDeckEntryInlineCard(systemDeck.id, hash, JSON.stringify(snapshot));
        })();

        if (systemDeck) {
            try {
                const file = this._readOrRebuild(systemDeck.global_hash, systemDeck);
                const entry = file.entries.find(e => e.cardHash === hash);
                if (entry) {
                    entry.card = snapshot;
                    file.modified = new Date().toISOString();
                    this._write(systemDeck.global_hash, file);
                }
            } catch { /* best-effort, mirrors deleteStandaloneCard */ }
            await sealEmitter.edit(this._sealRelPath(systemDeck.global_hash));
        }
    }

    async deleteStandaloneCard(hash) {
        const card = this.query.getFlashcardByHash(hash);
        if (!card) throw new Error(`Card not found: ${hash}`);
        if (card.document_id !== null && card.document_id !== undefined) {
            throw new Error('Card is linked to a document — delete from the document instead');
        }

        db.transaction(() => {
            this.query.deleteFlashcardDeckEntries(hash);
            this.query.deleteFlashcard(card.id);
        })();

        const systemDeck = this.query.getSystemDeck();
        if (systemDeck) {
            try {
                const file = this._read(systemDeck.global_hash);
                file.entries = file.entries.filter(e => e.cardHash !== hash);
                file.modified = new Date().toISOString();
                this._write(systemDeck.global_hash, file);
            } catch { /* best-effort */ }
            await sealEmitter.edit(this._sealRelPath(systemDeck.global_hash));
        }
    }

    // --- Vault Doctor support ---

    /**
     * Enumerates and parses every canonical deck file in _decks/.
     * @returns {Array<{ globalHash: string, data: object|null }>} data is null for malformed JSON.
     */
    listDeckFiles() {
        if (!fs.existsSync(this.decksPath)) return [];
        return fs.readdirSync(this.decksPath)
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
     * Compares _decks/*.json files against the Decks/DeckEntries tables.
     * Read-only.
     * @returns {{ fileWithoutDb: string[], dbWithoutFile: string[], corruptFiles: string[],
     *             entryMismatches: Array<{ deckHash, missingInDb: string[], missingInFile: string[] }>,
     *             danglingEntries: Array<{ deckHash, cardHash }> }}
     */
    diagnoseDecks() {
        const files = this.listDeckFiles();
        const dbDecks = this.query.getAllDecks();
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
            const dbEntries = this.query.getDeckEntries(d.id);
            const dbHashes = new Set(dbEntries.map(e => e.card_hash));

            const missingInDb = [...fileHashes].filter(h => !dbHashes.has(h));
            const missingInFile = [...dbHashes].filter(h => !fileHashes.has(h));
            if (missingInDb.length || missingInFile.length) {
                entryMismatches.push({ deckHash: d.global_hash, missingInDb, missingInFile });
            }
            for (const e of dbEntries) {
                if (!this.query.getFlashcardByHash(e.card_hash)) {
                    danglingEntries.push({ deckHash: d.global_hash, cardHash: e.card_hash });
                }
            }
        }
        return { fileWithoutDb, dbWithoutFile, corruptFiles, entryMismatches, danglingEntries };
    }

    // Inserts a deck (+ entries + graph connections) into the DB from its
    // canonical JSON. isSystem is only honored when no system deck exists yet —
    // the invariant is exactly one.
    _importDeckFile(globalHash, data) {
        db.transaction(() => {
            const isSystem = data.isSystem && !this.query.getSystemDeck() ? 1 : 0;
            const deckId = this.query.insertDeck({
                globalHash,
                name: data.name ?? 'Recovered deck',
                description: data.description ?? '',
                isSystem,
            });
            const deck = this.query.getDeckByHash(globalHash);
            (data.entries ?? []).forEach((e, i) => {
                this.query.insertDeckEntry({
                    deckId, cardHash: e.cardHash,
                    documentPath: e.documentPath ?? null,
                    position: i,
                    inlineCard: e.card ? JSON.stringify(e.card) : null,
                });
                if (deck.node_id) {
                    const cardNodeId = this.query.getFlashcardNodeIdByHash(e.cardHash);
                    if (cardNodeId) this.query.insertDeckConnection(deck.node_id, cardNodeId);
                }
            });
        })();
    }

    /**
     * Applies deck diagnosis: files without DB rows are imported (file wins),
     * DB rows without files self-heal via _readOrRebuild (DB is the next-best
     * truth there), and entry mismatches resolve in the file's favor — normal
     * ops write the file first, so it is the canonical side.
     * Dangling entries (card hash with no Flashcards row) are left for rebuild,
     * which can restore them from inline_card snapshots.
     * @returns {{ decksImported: number, deckFilesRebuilt: number, entriesAdded: number, entriesRemoved: number }}
     */
    repairFromFiles() {
        const diag = this.diagnoseDecks();
        const actions = { decksImported: 0, deckFilesRebuilt: 0, entriesAdded: 0, entriesRemoved: 0 };

        for (const hash of diag.fileWithoutDb) {
            this._importDeckFile(hash, this._read(hash));
            actions.decksImported++;
        }
        for (const hash of diag.dbWithoutFile) {
            this._readOrRebuild(hash, this.query.getDeckByHash(hash));
            actions.deckFilesRebuilt++;
        }
        for (const mm of diag.entryMismatches) {
            const deck = this.query.getDeckByHash(mm.deckHash);
            const data = this._read(mm.deckHash);
            db.transaction(() => {
                for (const h of mm.missingInDb) {
                    const entry = (data.entries ?? []).find(e => e.cardHash === h);
                    this.query.insertDeckEntry({
                        deckId: deck.id, cardHash: h,
                        documentPath: entry?.documentPath ?? null,
                        position: this.query.getDeckEntryCount(deck.id),
                        inlineCard: entry?.card ? JSON.stringify(entry.card) : null,
                    });
                    if (deck.node_id) {
                        const cardNodeId = this.query.getFlashcardNodeIdByHash(h);
                        if (cardNodeId) this.query.insertDeckConnection(deck.node_id, cardNodeId);
                    }
                    actions.entriesAdded++;
                }
                for (const h of mm.missingInFile) {
                    if (deck.node_id) {
                        const cardNodeId = this.query.getFlashcardNodeIdByHash(h);
                        if (cardNodeId) this.query.deleteDeckConnection(deck.node_id, cardNodeId);
                    }
                    this.query.deleteDeckEntry(deck.id, h);
                    actions.entriesRemoved++;
                }
            })();
        }
        return actions;
    }

    /**
     * Full _decks/*.json → DB import for the Doctor's rebuild path. Assumes the
     * deck tables were just wiped. Standalone cards are restored from their
     * inline_card snapshots (level resets to 0 — a standalone card's SRS state
     * has no canonical-layer home). Guarantees exactly one system deck.
     * @returns {{ decks: number, restoredCards: number, warnings: string[] }}
     */
    rebuildFromFiles() {
        const warnings = [];
        let decksImported = 0;
        let restoredCards = 0;

        for (const f of this.listDeckFiles()) {
            if (f.data === null) {
                warnings.push(`Corrupt deck file skipped: _decks/${f.globalHash}.json`);
                continue;
            }
            try {
                this._importDeckFile(f.globalHash, f.data);
                decksImported++;
            } catch (err) {
                warnings.push(`Failed to import deck ${f.globalHash}: ${err.message}`);
                continue;
            }

            // Restore document-less cards from their content snapshots.
            for (const e of f.data.entries ?? []) {
                if (!e.card || e.documentPath || this.query.getFlashcardByHash(e.cardHash)) continue;
                try {
                    db.transaction(() => {
                        const nodeId = this.query.createNode('Flashcard');
                        this.query.insertFlashcard({
                            globalHash: e.cardHash, nodeId, documentId: null,
                            vanillaData: e.card.vanillaData ?? null,
                            customData: e.card.customData ?? null,
                            category: e.card.category ?? null,
                            cardType: e.card.cardType ?? 'basic',
                            name: e.card.name ?? null,
                            level: 0, sm2Reps: 0, fileIndex: 0,
                        });
                        const deck = this.query.getDeckByHash(f.globalHash);
                        if (deck?.node_id) {
                            const cardNodeId = this.query.getFlashcardNodeIdByHash(e.cardHash);
                            if (cardNodeId) this.query.insertDeckConnection(deck.node_id, cardNodeId);
                        }
                    })();
                    restoredCards++;
                } catch (err) {
                    warnings.push(`Failed to restore standalone card ${e.cardHash}: ${err.message}`);
                }
            }
        }

        // The system deck must exist even if its file was lost.
        if (!this.query.getSystemDeck()) {
            const globalHash = crypto.randomUUID();
            this.query.insertDeck({ globalHash, name: 'Cards', description: '', isSystem: 1 });
            this._readOrRebuild(globalHash, this.query.getDeckByHash(globalHash));
            warnings.push('System deck file was missing — recreated empty.');
            decksImported++;
        }

        return { decks: decksImported, restoredCards, warnings };
    }
}
