/**
 * Accounts API (/api/accounts): who may reach this install and as what.
 * Admin-only reads of someone else's progress and graph live here, never under
 * srs or documents.
 */

import { request } from "./client.js";

/** @returns {Promise<{accounts: Array<object>, you: object, limit: number|null}>} */
export function listAccounts() {
  return request("GET", "/api/accounts");
}

/** @param {{name: string, email: string, role: string}} account */
export function createAccount(account) {
  return request("POST", "/api/accounts", account);
}

/**
 * @param {string} id
 * @param {{role?: string, active?: boolean}} changes
 */
export function updateAccount(id, changes) {
  return request("PATCH", `/api/accounts/${encodeURIComponent(id)}`, changes);
}

/**
 * One account's study summary, in the shape `getStatistics()` gives the caller for themselves
 * (completeness included). Admin-only; with `getAccountGraph` below, the only two calls in the
 * app that read a schedule belonging to someone else.
 *
 * @param {string} id
 * @param {string} [algorithm]
 * @returns {Promise<{account: object, scope: string, statistics: object}>}
 */
export function getAccountProgress(id, algorithm = null) {
  const query = algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : "";
  return request(
    "GET",
    `/api/accounts/${encodeURIComponent(id)}/progress${query}`,
  );
}

/**
 * The knowledge graph as `getGraph()` returns it, with every node's `learned` and `mass`
 * computed from this account's schedule instead of the caller's. Admin-only.
 *
 * @param {string} id
 * @returns {Promise<{account: object, scope: string, nodes: Array<object>, edges: Array<object>}>}
 */
export function getAccountGraph(id) {
  return request("GET", `/api/accounts/${encodeURIComponent(id)}/graph`);
}

/**
 * Someone's Logs, read-only, in the shapes `/api/diary` gives the caller for their own: the
 * dates, one day's summary (throws with `.status === 404` when there is none), one day's entry.
 * Author only; with the two above, the calls that read what belongs to someone else.
 */
export function getAccountLogs(id) {
  return request("GET", `/api/accounts/${encodeURIComponent(id)}/logs`);
}

export function getAccountLogSummary(id, date) {
  return request("GET", `/api/accounts/${encodeURIComponent(id)}/logs/summary/${date}`);
}

export function getAccountLogEntry(id, date) {
  return request("GET", `/api/accounts/${encodeURIComponent(id)}/logs/entry/${date}`);
}

/**
 * Issues a token. **The plaintext is in this response and nowhere else, ever.**
 * @returns {Promise<{id: string, token: string, label: string, accountId: string, notice: string}>}
 */
export function issueToken(accountId, label = "") {
  return request(
    "POST",
    `/api/accounts/${encodeURIComponent(accountId)}/tokens`,
    { label },
  );
}

export function revokeToken(tokenId) {
  return request(
    "DELETE",
    `/api/accounts/tokens/${encodeURIComponent(tokenId)}`,
  );
}

/**
 * Mints a new Author token and revokes every previous one, in one operation. Author only.
 * @returns {Promise<{token: string, accountId: string, revoked: number, notice: string}>}
 */
export function rotatePureToken(label = "Pure token") {
  return request("POST", "/api/accounts/pure-token", { label });
}
