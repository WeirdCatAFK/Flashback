/**
 * Diary API (/api/diary): the per-day summaries and entries.
 */

import { request } from "./client.js";

/**
 * Regenerate the day's summary (cumulative, idempotent) from ReviewLogs. Omit
 * `date` for today. Returns { ok, summary } — summary is null when the day had
 * no reviews. This is the study-session-completion hook.
 */
export const generateSummary = (date) =>
  request("POST", "/api/diary/summary", date ? { date } : {});

/** Re-derive every summary from ReviewLogs. Returns { ok, count }. */
export const rebuildSummaries = () => request("POST", "/api/diary/rebuild");

/** Date-descending [{ date, hasSummary, hasEntry }], optionally bounded. */
export const listDiary = ({ from, to } = {}) => {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const q = qs.toString();
  return request("GET", `/api/diary${q ? `?${q}` : ""}`);
};

/** The summary JSON for a date. Throws with `.status === 404` when none exists. */
export const getSummary = (date) =>
  request("GET", `/api/diary/summary/${date}`);

/** { date, content } — content is '' when the user has no entry for that day. */
export const getEntry = (date) => request("GET", `/api/diary/entry/${date}`);

/**
 * Save the markdown entry. Empty content for a day with no existing entry is a
 * no-op server-side. Returns { ok, created, empty }.
 */
export const saveEntry = (date, content) =>
  request("PUT", `/api/diary/entry/${date}`, { content });
