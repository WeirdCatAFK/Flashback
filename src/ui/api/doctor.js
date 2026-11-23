import { request } from "./client.js";

export const checkIndex = () => request("GET", "/api/doctor/check");

export const syncIndex = (sealDrift = true) =>
  request("POST", "/api/doctor/sync", { sealDrift });

export const rebuildIndex = () =>
  request("POST", "/api/doctor/rebuild", { confirm: "REBUILD" });
