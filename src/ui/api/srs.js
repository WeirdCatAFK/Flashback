import { request } from "./client.js";

export const getStats = () => request("GET", "/api/srs/stats");

export const getStatistics = (algorithm) =>
  request(
    "GET",
    `/api/srs/statistics${algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : ""}`,
  );

export const submitReview = (
  path,
  flashcardHash,
  outcome,
  easeFactor,
  newLevel,
  algorithm,
  opts = {},
) =>
  request("POST", "/api/srs/review", {
    path,
    flashcardHash,
    outcome,
    easeFactor,
    newLevel,
    algorithm,
    rating: opts.rating,
    requestRetention: opts.requestRetention,
    sessionId: opts.sessionId,
    sessionPosition: opts.sessionPosition,
    prevCardHash: opts.prevCardHash,
  });

export const undoReview = (path, flashcardHash, algorithm) =>
  request("POST", "/api/srs/undo", { path, flashcardHash, algorithm });

export const migrateProgress = (from, to) =>
  request("POST", "/api/srs/migrate", { from, to });

export const optimizeFsrs = () => request("POST", "/api/srs/optimize");

export const getFsrsInfo = () => request("GET", "/api/srs/fsrs-info");

export const getDue = ({
  algorithm,
  folder,
  document,
  deck,
  tags,
  maxNew,
  minPriority,
  order,
  readOnly,
  exclude,
  retention,
} = {}) => {
  const qs = new URLSearchParams();
  if (algorithm) qs.set("algorithm", algorithm);
  if (retention != null) qs.set("retention", String(retention));
  if (folder) qs.set("folder", folder);
  if (document) qs.set("document", document);
  if (deck) qs.set("deck", deck);
  if (tags?.length) tags.forEach((t) => qs.append("tag", t));
  if (maxNew != null) qs.set("maxNew", String(maxNew));
  if (minPriority > 0) qs.set("minPriority", String(minPriority));
  if (order) qs.set("order", order);
  if (readOnly) qs.set("read", "only");
  exclude?.folders?.forEach((f) => qs.append("excludeFolder", f));
  exclude?.documents?.forEach((d) => qs.append("excludeDocument", d));
  exclude?.decks?.forEach((d) => qs.append("excludeDeck", d.hash ?? d));
  exclude?.tags?.forEach((t) => qs.append("excludeTag", t));
  const q = qs.toString();
  return request("GET", `/api/srs/due${q ? `?${q}` : ""}`);
};
