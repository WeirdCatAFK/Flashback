import { request, upload, getBaseUrl, appendToken } from "./client.js";

export const listDecks = (algorithm = null) =>
  request("GET", `/api/decks${algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : ""}`);

export const createDeck = (name, description = "") =>
  request("POST", "/api/decks", { name, description });

export const getDeck = (hash, algorithm = null) =>
  request("GET", `/api/decks/${hash}${algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : ""}`);

export const updateDeck = (hash, data) =>
  request("PUT", `/api/decks/${hash}`, data);

export const deckCoverUrl = (hash, file) =>
  appendToken(`${getBaseUrl()}/api/decks/${hash}/cover?v=${encodeURIComponent(file ?? "")}`);

export const uploadDeckCover = (hash, file) => {
  const form = new FormData();
  form.append("file", file);
  return upload(`/api/decks/${hash}/cover`, form);
};

export const setDeckCover = (hash, change) =>
  request("PUT", `/api/decks/${hash}/cover`, change);

export const removeDeckCover = (hash) =>
  request("DELETE", `/api/decks/${hash}/cover`);

export const deleteDeck = (hash) => request("DELETE", `/api/decks/${hash}`);

export const getDeckContents = (hash) =>
  request("GET", `/api/decks/${hash}/contents`);

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

export const updateCard = (hash, data) =>
  request("PUT", `/api/flashcards/${hash}`, data);

export const getCardDetail = (hash, algorithm = null) => {
  const qs = algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : "";
  return request("GET", `/api/flashcards/${hash}/detail${qs}`);
};

export const deleteCard = (hash) =>
  request("DELETE", `/api/flashcards/${hash}`);

export const searchCards = ({
  search,
  level = null,
  cardType = null,
  flagged = false,
  flagKind = null,
  band = null,
  tag = null,
  category = null,
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
  if (tag) qs.set("tag", tag);
  if (category !== null) qs.set("category", String(category));
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

export const getCatalogueSummary = (algorithm = null) =>
  request("GET", `/api/decks/cards/summary${algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : ""}`);

export const dismissCardFlag = (hash, kind) =>
  request("POST", `/api/flashcards/${hash}/flags/${kind}/dismiss`, {});
