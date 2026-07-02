import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import query from './query.js';
import db from './Database.js';
import { getWorkspacePath } from './Config.js';

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

    _read(globalHash) {
        return JSON.parse(fs.readFileSync(this._filePath(globalHash), 'utf-8'));
    }

    // Reads a deck's canonical JSON, rebuilding it from the DB if the file is
    // unexpectedly missing (decks.js doesn't participate in Seal yet — see
    // Backlog #38 — so a deck's file has no version history to restore from;
    // the DeckEntries table is the next-best source of truth). This turns a
    // desync into a self-heal instead of a raw fs crash reaching the caller.
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

    createDeck(name, description = '') {
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
        return globalHash;
    }

    getDeck(globalHash) {
        const deck = this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);
        const entries = this.query.getDeckEntries(deck.id);
        return { ...deck, entries, entry_count: entries.length };
    }

    updateDeck(globalHash, { name, description }) {
        const deck = this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);

        this._ensureSystemDeckFile();
        const file = this._readOrRebuild(globalHash, deck);
        if (name !== undefined) file.name = name;
        if (description !== undefined) file.description = description;
        file.modified = new Date().toISOString();

        this._write(globalHash, file);
        try {
            db.transaction(() => {
                this.query.updateDeck(deck.id, {
                    name: name ?? deck.name,
                    description: description !== undefined ? description : deck.description,
                });
            })();
        } catch (err) {
            // best-effort rollback: re-read original from DB isn't feasible here; log and rethrow
            throw err;
        }
    }

    deleteDeck(globalHash) {
        const deck = this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);
        if (deck.is_system) throw new Error('Cannot delete the system deck');

        this._remove(globalHash);
        db.transaction(() => {
            this.query.deleteDeck(deck.id);
        })();
    }

    addEntry(deckHash, { cardHash, documentPath = null, inlineCard = null }) {
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
    }

    removeEntry(deckHash, cardHash) {
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
    }

    searchCards({ search, level = null, cardType = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}) {
        return this.query.getAllFlashcards({ search, level, cardType, sortBy, sortDir, limit, offset });
    }

    getCardCount({ search, level = null, cardType = null } = {}) {
        return this.query.getFlashcardCountFiltered({ search, level, cardType });
    }

    createStandaloneCard({ frontText, backText, name, cardType = 'basic', category = null, customHtml = null, media = null } = {}) {
        const systemDeck = this.query.getSystemDeck();
        if (!systemDeck) throw new Error('System deck not initialised — run migrations');
        if (category && !this.query.getCategoryByName(category)) {
            throw new Error(`Unknown category: "${category}". Call GET /api/categories for valid values.`);
        }

        const globalHash = crypto.randomUUID();

        db.transaction(() => {
            const nodeId = this.query.createNode('Flashcard');
            this.query.insertFlashcard({
                globalHash, nodeId, documentId: null,
                vanillaData: { 
                    frontText: frontText || null, 
                    backText: backText || null,
                    media: media || {}
                },
                customData: customHtml ? { html: customHtml } : null,
                category, cardType, name,
                level: 0, sm2Reps: 0, fileIndex: 0,
            });
            const position = this.query.getDeckEntryCount(systemDeck.id);
            this.query.insertDeckEntry({
                deckId: systemDeck.id, cardHash: globalHash,
                documentPath: null, position, inlineCard: null,
            });
            if (systemDeck.node_id) {
                const cardNodeId = this.query.getFlashcardNodeIdByHash(globalHash);
                if (cardNodeId) this.query.insertDeckConnection(systemDeck.node_id, cardNodeId);
            }
        })();

        this._ensureSystemDeckFile();
        const file = this._read(systemDeck.global_hash);
        file.entries.push({ cardHash: globalHash, documentPath: null });
        file.modified = new Date().toISOString();
        this._write(systemDeck.global_hash, file);

        return globalHash;
    }

    updateStandaloneCard(hash, { frontText, backText, name, cardType, category } = {}) {
        const card = this.query.getFlashcardByHash(hash);
        if (!card) throw new Error(`Card not found: ${hash}`);
        if (card.document_id !== null && card.document_id !== undefined) {
            throw new Error('Card is linked to a document — edit from the document instead');
        }
        if (category && !this.query.getCategoryByName(category)) {
            throw new Error(`Unknown category: "${category}". Call GET /api/categories for valid values.`);
        }
        db.transaction(() => {
            this.query.updateFlashcardContentByHash(hash, { frontText, backText, name, cardType, category });
        })();
    }

    deleteStandaloneCard(hash) {
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
            } catch (_) { /* best-effort */ }
        }
    }
}
