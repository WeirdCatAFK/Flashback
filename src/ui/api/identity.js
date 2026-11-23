import { request } from "./client.js";

const ipc = () => window.flashback ?? null;

export function getEffectiveIdentity() {
  return request("GET", "/api/identity");
}

export async function getStoredIdentity() {
  return (
    (await ipc()?.getIdentity?.()) ?? {
      user: { name: "", email: "" },
      override: null,
      suggested: { name: "", email: "" },
      activeVaultId: null,
    }
  );
}

export async function setIdentity(identity) {
  return (
    (await ipc()?.setIdentity?.(identity)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function setVaultIdentity(vaultId, identity) {
  return (
    (await ipc()?.setVaultIdentity?.(vaultId, identity)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}
