// Migration 003 — System deck
//
// Adds is_system column to Decks and seeds the "Cards" system deck.
// Safe to re-run: uses IF NOT EXISTS / OR IGNORE / ALTER TABLE guard.

import { SYSTEM_DECK_HASH } from '../defaults/DefaultData.js';

export const version = 3;
export const description = 'System deck: is_system column on Decks + Cards deck seed';

export async function shouldRun(db) {
    const hasCol = (await db.prepare("PRAGMA table_info(Decks)").all()).find(c => c.name === 'is_system');
    const hasDeck = await db.prepare("SELECT id FROM Decks WHERE global_hash = ?").get(SYSTEM_DECK_HASH);
    return !hasCol || !hasDeck;
}

export async function up(db) {
    const cols = await db.prepare("PRAGMA table_info(Decks)").all();
    if (!cols.find(c => c.name === 'is_system')) {
        await db.exec('ALTER TABLE Decks ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0');
    }

    const deckNodeTypeId = (await db.prepare("SELECT id FROM NodeTypes WHERE name = 'Deck'").get())?.id;
    if (!deckNodeTypeId) return;

    const existing = await db.prepare("SELECT id FROM Decks WHERE global_hash = ?").get(SYSTEM_DECK_HASH);
    if (!existing) {
        const nodeInfo = await db.prepare('INSERT INTO Nodes (type_id) VALUES (?)').run(deckNodeTypeId);
        await db.prepare(
            "INSERT INTO Decks (node_id, global_hash, name, is_system) VALUES (?, ?, 'Cards', 1)"
        ).run(nodeInfo.lastInsertRowid, SYSTEM_DECK_HASH);
    } else {
        await db.prepare('UPDATE Decks SET is_system = 1 WHERE global_hash = ?').run(SYSTEM_DECK_HASH);
    }
}
