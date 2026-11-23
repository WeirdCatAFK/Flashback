import { request } from "./client.js";

export const getLog = ({ limit = 20, cursor = null } = {}) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  return request("GET", `/api/seal/log?${params}`);
};

export const inspectDrift = () => request("GET", "/api/seal/inspect");

export const getCommitFiles = (oid) =>
  request("GET", `/api/seal/commit/${oid}/files`);

export const rollback = (ref) => request("POST", "/api/seal/rollback", { ref });
