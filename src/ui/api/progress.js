import { request } from "./client.js";

const q = (params) => {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const v of value)
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
};

export const getProgress = (path) =>
  request("GET", `/api/progress${q({ path })}`);

export const setProgress = (path, body) =>
  request("PUT", "/api/progress", { path, ...body });

export const clearProgress = (path) =>
  request("DELETE", `/api/progress${q({ path })}`);

export const listProgress = (folder, folders = []) =>
  request("GET", `/api/progress/list${q({ folder, folders })}`);

export const getRollup = (path) =>
  request("GET", `/api/progress/rollup${q({ path })}`);

export const listReading = (limit) =>
  request("GET", `/api/progress/reading${q({ limit })}`);

export const getCoverage = (path) =>
  request("GET", `/api/progress/coverage${q({ path })}`);
