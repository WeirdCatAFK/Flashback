/**
 * Decks and cards API (/api/decks, /api/flashcards): deck CRUD, entries, card
 * search and deletion.
 */

import { request, upload, getBaseUrl, appendToken } from "./client.js";

/**
 * Every deck, each with its stored `color` (null = none; see shared/deckColors.js)
 * and `standing: { due, fresh, longTerm }` — how its cards stand for the caller
 * under `algorithm`.
 */
export const listDecks = (algorithm = null) =>
  request("GET", `/api/decks${algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : ""}`);

export const createDeck = (name, description = "") =>
  request("POST", "/api/decks", { name, description });

/** One deck with its `color`, tags, `standing`, and entries each carrying `gap`. */
export const getDeck = (hash, algorithm = null) =>
  request("GET", `/api/decks/${hash}${algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : ""}`);

/** `{ name?, description?, color? }` — `color` a palette id, or null for the default. */
export const updateDeck = (hash, data) =>
  request("PUT", `/api/decks/${hash}`, data);

/**
 * The URL of a deck's cover image for an <img>. `file` is the cover's stored name —
 * it changes on every upload, so it doubles as a cache key.
 */
export const deckCoverUrl = (hash, file) =>
  appendToken(`${getBaseUrl()}/api/decks/${hash}/cover?v=${encodeURIComponent(file ?? "")}`);

/** Uploads an image file as the deck's cover. Resolves `{ cover }`. */
export const uploadDeckCover = (hash, file) => {
  const form = new FormData();
  form.append("file", file);
  return upload(`/api/decks/${hash}/cover`, form);
};

/** `{ pattern }` for a drawn cover, `{ y }` (0..1) to reposition the image. Resolves `{ cover }`. */
export const setDeckCover = (hash, change) =>
  request("PUT", `/api/decks/${hash}/cover`, change);

/** Removes the deck's cover. */
export const removeDeckCover = (hash) =>
  request("DELETE", `/api/decks/${hash}/cover`);

/** Removes the deck only — its cards survive as standalone cards. */
export const deleteDeck = (hash) => request("DELETE", `/api/decks/${hash}`);

/** What erasing the deck *and its cards* would destroy, for the confirm dialog. */
export const getDeckContents = (hash) =>
  request("GET", `/api/decks/${hash}/contents`);

/**
 * Deletes the deck AND its cards. `includeShared` also destroys cards that another
 * deck holds; left false they survive and are merely unlinked.
 */
export const purgeDeck = (hash, includeShared = false) =>
  request("POST", `/api/decks/${hash}/purge`, { includeShared });

export const setDeckTags = (hash, tags) =>
  request("PUT", `/api/decks/${hash}/tags`, { tags });

export const addEntry = (deckHash, cardHash, documentPath = null) =>
  request("POST", `/api/decks/${deckHash}/entries`, { cardHash, documentPath });

export const removeEntry = (deckHash, cardHash) =>
  request(
    "DELETE",
    `/api/decks/${deckHash}/entries/${encodeURIComponent(cardHash)}`,
  );

export const createStandaloneCard = ({
  frontText,
  backText,
  answerText,
  name,
  cardType,
  category,
  customHtml,
  tags,
} = {}) =>
  request("POST", "/api/flashcards", {
    frontText,
    backText,
    answerText,
    name,
    cardType,
    category,
    customHtml,
    tags,
  });

/**
 * Edits any card by hash — standalone or document-anchored. As with deleteCard the
 * server resolves which canonical file the card lives in, so callers don't branch.
 */
export const updateCard = (hash, data) =>
  request("PUT", `/api/flashcards/${hash}`, data);

/**
 * Card content + current schedule + full review ledger + a sampled retention curve,
 * in one request. `algorithm` is the local SRS preference; omit it and the server
 * detects the vault's and echoes back the one it used.
 */
export const getCardDetail = (hash, algorithm = null) => {
  const qs = algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : "";
  return request("GET", `/api/flashcards/${hash}/detail${qs}`);
};

/**
 * Deletes any card by hash — standalone or document-anchored. The server resolves
 * which canonical file the card lives in (system deck JSON vs. document sidecar) and
 * unlinks it from any decks holding it, so callers never branch on that themselves.
 */
export const deleteCard = (hash) =>
  request("DELETE", `/api/flashcards/${hash}`);

/**
 * `flagged` restricts to cards carrying a live card-health flag; `flagKind` to one
 * signature. Each returned row's `flags` is a comma-joined list of kinds (or null),
 * and `gap` is the caller's days between reviews under `algorithm` (null = new).
 *
 * `band` keeps one gap band; `source` is 'standalone', or 'folder'/'document' with
 * `sourcePath`. `groupBy` ('gap' | 'source') orders the groups on top of `sortBy`
 * and adds `groups: [{ key, count }]` covering every page.
 */
export const searchCards = ({
  search,
  level = null,
  cardType = null,
  flagged = false,
  flagKind = null,
  band = null,
  source = null,
  sourcePath = null,
  groupBy = null,
  algorithm = null,
  sortBy = "level",
  sortDir = "desc",
  limit = 50,
  offset = 0,
} = {}) => {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  if (level !== null) qs.set("level", String(level));
  if (cardType) qs.set("cardType", cardType);
  if (flagKind) qs.set("flagKind", flagKind);
  else if (flagged) qs.set("flagged", "1");
  if (band) qs.set("band", band);
  if (source) qs.set("source", source);
  if (sourcePath) qs.set("sourcePath", sourcePath);
  if (groupBy) qs.set("groupBy", groupBy);
  if (algorithm) qs.set("algorithm", algorithm);
  if (sortBy !== "level") qs.set("sortBy", sortBy);
  if (sortDir !== "desc") qs.set("sortDir", sortDir);
  qs.set("limit", String(limit));
  qs.set("offset", String(offset));
  return request("GET", `/api/decks/cards?${qs}`);
};

/**
 * The Flashcards sidebar in one read: `{ total, standalone: { cards, longTerm },
 * documents: [{ path, cards, longTerm }], bands: { new, d1, … }, flags: { any,
 * mouthful, probe } }`, with gaps computed under `algorithm`.
 */
export const getCatalogueSummary = (algorithm = null) =>
  request("GET", `/api/decks/cards/summary${algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : ""}`);

/**
 * The user has ruled on a card-health flag: suppress it so it stops re-announcing
 * itself on every later failure. Returns the card's remaining flags.
 */
export const dismissCardFlag = (hash, kind) =>
  request("POST", `/api/flashcards/${hash}/flags/${kind}/dismiss`, {});
