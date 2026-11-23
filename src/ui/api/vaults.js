import { request } from "./client.js";

const ipc = () => window.flashback ?? null;

export function getVaultIdentity() {
  return request("GET", "/api/vault");
}

export function getServerRemotes() {
  return request("GET", "/api/remotes");
}

export async function listVaults() {
  return (await ipc()?.listVaults?.()) ?? { activeVaultId: null, vaults: [] };
}

export async function createVault(name) {
  return (
    (await ipc()?.createVault?.(name)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function renameVault(id, name) {
  return (
    (await ipc()?.renameVault?.(id, name)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function removeVault(id) {
  return (
    (await ipc()?.removeVault?.(id)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function switchVault(id) {
  return (
    (await ipc()?.switchVault?.(id)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function openVaultFromDisk() {
  return (
    (await ipc()?.openVaultFromDisk?.()) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function listRemotes() {
  return (await ipc()?.listRemotes?.()) ?? [];
}

export async function addRemote(remote) {
  return (
    (await ipc()?.addRemote?.(remote)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function removeRemote(id) {
  return (
    (await ipc()?.removeRemote?.(id)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function testRemote(id) {
  return (
    (await ipc()?.testRemote?.(id)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function connectRemote(id) {
  return (
    (await ipc()?.connectRemote?.(id)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

export async function connectLocal() {
  return (
    (await ipc()?.connectLocal?.()) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}
