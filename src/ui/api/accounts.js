import { request } from "./client.js";

export function listAccounts() {
  return request("GET", "/api/accounts");
}

export function createAccount(account) {
  return request("POST", "/api/accounts", account);
}

export function updateAccount(id, changes) {
  return request("PATCH", `/api/accounts/${encodeURIComponent(id)}`, changes);
}

export function getAccountProgress(id, algorithm = null) {
  const query = algorithm ? `?algorithm=${encodeURIComponent(algorithm)}` : "";
  return request(
    "GET",
    `/api/accounts/${encodeURIComponent(id)}/progress${query}`,
  );
}

export function getAccountGraph(id) {
  return request("GET", `/api/accounts/${encodeURIComponent(id)}/graph`);
}

export function getAccountLogs(id) {
  return request("GET", `/api/accounts/${encodeURIComponent(id)}/logs`);
}

export function getAccountLogSummary(id, date) {
  return request("GET", `/api/accounts/${encodeURIComponent(id)}/logs/summary/${date}`);
}

export function getAccountLogEntry(id, date) {
  return request("GET", `/api/accounts/${encodeURIComponent(id)}/logs/entry/${date}`);
}

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

export function rotatePureToken(label = "Pure token") {
  return request("POST", "/api/accounts/pure-token", { label });
}
