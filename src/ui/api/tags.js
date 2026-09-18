/**
 * Tags API (/api/tags).
 */

import { request } from "./client.js";

export const getTags = () =>
  request("GET", "/api/documents/tags").then((r) => r.tags);

/** [{ name, count }] — count is how many entities apply the tag directly. */
export const getTagUsage = () =>
  request("GET", "/api/documents/tags/usage").then((r) => r.tags);
