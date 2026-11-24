import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { testDataDir } from '../support/testData.js';

process.env.USER_DATA_PATH = testDataDir('search');
fs.rmSync(process.env.USER_DATA_PATH, { recursive: true, force: true });

const { default: validate } = await import('../../src/api/config/validate.js');
if (!await validate()) {
    console.error('Validation failed.');
    process.exit(1);
}

const Decks = await import('../../src/api/access/modules/decks.js');
const searchRows = await import('../../src/api/access/resources/db/search.js');
const { sealTools, sealEmitter } = await import('../../src/api/seal/seal.js');
const { default: db } = await import('../../src/api/access/primitives/database.js');

describe('search finds the cards of a deck', () => {
    let inDeck, custom;

    before(async () => {
        await sealTools.init();
        await Decks.onVaultOpened();
        const deck = await Decks.createDeck('Japanese_Hiragana_Basic', '');
        inDeck = await Decks.createStandaloneCard({ frontText: 'あ', backText: 'a' });
        await Decks.addEntry(deck, { cardHash: inDeck });
        custom = await Decks.createStandaloneCard({ cardType: 'custom', customHtml: '<div class="kana">hiragana chart</div>' });
    });

    after(async () => {
        await sealEmitter.quiesce();
        db.close();
    });

    const found = async (q) => (await searchRows.superSearch({ q }, 'owner')).flashcards.map((c) => c.global_hash);

    it('matches a card by the name of a deck it belongs to', async () => {
        assert.ok((await found('hiragana')).includes(inDeck));
    });

    it('matches a custom card by the text inside its HTML', async () => {
        assert.ok((await found('hiragana')).includes(custom));
    });
});
