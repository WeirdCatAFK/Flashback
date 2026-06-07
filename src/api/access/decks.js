import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import query from './query.js';
import db from './database.js';
import { getWorkspacePath } from './config.js';

const DECKS_DIR = '_decks';

export default class Decks {
    constructor() {
        this.query = query;
        this.decksPath = path.join(getWorkspacePath(), DECKS_DIR);
        if (!fs.existsSync(this.decksPath)) {
            fs.mkdirSync(this.decksPath, { recursive: true });
        }
    }

    _filePath(globalHash) {
        return path.join(this.decksPath, `${globalHash}.json`);
    }

    _read(globalHash) {
        return JSON.parse(fs.readFileSync(this._filePath(globalHash), 'utf-8'));
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
        return { ...deck, entries };
    }

    updateDeck(globalHash, { name, description }) {
        const deck = this.query.getDeckByHash(globalHash);
        if (!deck) throw new Error(`Deck not found: ${globalHash}`);

        const file = this._read(globalHash);
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

        const file = this._read(deckHash);
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
            })();
        } catch (err) {
            // rollback file
            file.entries.pop();
            this._write(deckHash, file);
            throw err;
        }
    }

    removeEntry(deckHash, cardHash) {
        const deck = this.query.getDeckByHash(deckHash);
        if (!deck) throw new Error(`Deck not found: ${deckHash}`);

        const file = this._read(deckHash);
        const before = [...file.entries];
        file.entries = file.entries.filter(e => e.cardHash !== cardHash);
        file.modified = new Date().toISOString();

        this._write(deckHash, file);
        try {
            db.transaction(() => {
                this.query.deleteDeckEntry(deck.id, cardHash);
            })();
        } catch (err) {
            file.entries = before;
            this._write(deckHash, file);
            throw err;
        }
    }

    searchCards({ search, limit = 50, offset = 0 } = {}) {
        return this.query.getAllFlashcards({ search, limit, offset });
    }

    getCardCount({ search } = {}) {
        return this.query.getFlashcardCountFiltered({ search });
    }
}
