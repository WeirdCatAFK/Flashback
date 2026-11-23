import { request } from "./client.js";

export const getTags = () =>
  request("GET", "/api/documents/tags").then((r) => r.tags);

export const getTagOverview = () =>
  request("GET", "/api/documents/tags/overview").then((r) => r.tags);

export const renameTag = (from, to) =>
  request("POST", "/api/documents/tags/rename", { from, to });

export const removeTag = (from) =>
  request("POST", "/api/documents/tags/rename", { from, to: null });
