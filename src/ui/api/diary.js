import { request } from "./client.js";

export const generateSummary = (date) =>
  request("POST", "/api/diary/summary", date ? { date } : {});

export const rebuildSummaries = () => request("POST", "/api/diary/rebuild");

export const listDiary = ({ from, to } = {}) => {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const q = qs.toString();
  return request("GET", `/api/diary${q ? `?${q}` : ""}`);
};

export const getSummary = (date) =>
  request("GET", `/api/diary/summary/${date}`);

export const getEntry = (date) => request("GET", `/api/diary/entry/${date}`);

export const saveEntry = (date, content) =>
  request("PUT", `/api/diary/entry/${date}`, { content });
