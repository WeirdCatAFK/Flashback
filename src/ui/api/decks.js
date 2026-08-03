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

// Edits any card by hash — standalone or document-anchored. As with deleteCard the
// server resolves which canonical file the card lives in, so callers don't branch.
export const updateCard = (hash, data) =>
    request('PUT', `/api/flashcards/${hash}`, data);

// Card content + current schedule + full review ledger + a sampled retention curve,
// in one request. `algorithm` is the local SRS preference; omit it and the server
// detects the vault's and echoes back the one it used.
export const getCardDetail = (hash, algorithm = null) => {
    const qs = algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : '';
    return request('GET', `/api/flashcards/${hash}/detail${qs}`);
};

// Deletes any card by hash — standalone or document-anchored. The server resolves
// which canonical file the card lives in (system deck JSON vs. document sidecar) and
// unlinks it from any decks holding it, so callers never branch on that themselves.
export const deleteCard = (hash) =>
    request('DELETE', `/api/flashcards/${hash}`);

// `flagged` restricts to cards carrying a live card-health flag; `flagKind` to one
// signature. Each returned row's `flags` is a comma-joined list of kinds (or null).
export const searchCards = ({ search, level = null, cardType = null, flagged = false, flagKind = null, sortBy = 'level', sortDir = 'desc', limit = 50, offset = 0 } = {}) => {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    if (level !== null) qs.set('level', String(level));
    if (cardType) qs.set('cardType', cardType);
    if (flagKind) qs.set('flagKind', flagKind);
    else if (flagged) qs.set('flagged', '1');
    if (sortBy !== 'level') qs.set('sortBy', sortBy);
    if (sortDir !== 'desc') qs.set('sortDir', sortDir);
    qs.set('limit', String(limit));
    qs.set('offset', String(offset));
    return request('GET', `/api/decks/cards?${qs}`);
};

// The user has ruled on a card-health flag: suppress it so it stops re-announcing
// itself on every later failure. Returns the card's remaining flags.
export const dismissCardFlag = (hash, kind) =>
    request('POST', `/api/flashcards/${hash}/flags/${kind}/dismiss`, {});
