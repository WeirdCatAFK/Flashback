import { request } from './client.js';

export const listDecks = () =>
    request('GET', '/api/decks');

export const createDeck = (name, description = '') =>
    request('POST', '/api/decks', { name, description });

export const getDeck = (hash) =>
    request('GET', `/api/decks/${hash}`);

export const updateDeck = (hash, data) =>
    request('PUT', `/api/decks/${hash}`, data);

export const deleteDeck = (hash) =>
    request('DELETE', `/api/decks/${hash}`);

export const setDeckTags = (hash, tags) =>
    request('PUT', `/api/decks/${hash}/tags`, { tags });

export const addEntry = (deckHash, cardHash, documentPath = null) =>
    request('POST', `/api/decks/${deckHash}/entries`, { cardHash, documentPath });

export const removeEntry = (deckHash, cardHash) =>
    request('DELETE', `/api/decks/${deckHash}/entries/${encodeURIComponent(cardHash)}`);

export const createStandaloneCard = ({ frontText, backText, name, cardType, category, customHtml } = {}) =>
    request('POST', '/api/flashcards', { frontText, backText, name, cardType, category, customHtml });

export const updateStandaloneCard = (hash, data) =>
    request('PUT', `/api/flashcards/${hash}`, data);

export const deleteStandaloneCard = (hash) =>
    request('DELETE', `/api/flashcards/${hash}`);

export const searchCards = ({ search, level = null, cardType = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}) => {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    if (level !== null) qs.set('level', String(level));
    if (cardType) qs.set('cardType', cardType);
    if (sortBy !== 'level') qs.set('sortBy', sortBy);
    if (sortDir !== 'desc') qs.set('sortDir', sortDir);
    qs.set('limit', String(limit));
    qs.set('offset', String(offset));
    return request('GET', `/api/decks/cards?${qs}`);
};
