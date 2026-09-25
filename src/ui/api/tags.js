/**
 * Tags API (/api/tags).
 */

import { request } from "./client.js";

export const getTags = () =>
  request("GET", "/api/documents/tags").then((r) => r.tags);

/**
 * [{ name, folders, documents, decks, cardsDirect, cards }] — where each tag is applied,
 * and how many cards carry it (their own or inherited).
 */
export const getTagOverview = () =>
  request("GET", "/api/documents/tags/overview").then((r) => r.tags);

/** Renames a tag on every file, folder, deck and card that carries it. */
export const renameTag = (from, to) =>
  request("POST", "/api/documents/tags/rename", { from, to });

/** Removes a tag from everything that carries it. */
export const removeTag = (from) =>
  request("POST", "/api/documents/tags/rename", { from, to: null });
