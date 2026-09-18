/**
 * Vault and remote registries: the identity handshake over HTTP, and everything
 * else over Electron IPC — listing, creating, renaming, switching and removing
 * vaults, and the remotes the renderer may point itself at.
 */

import { request } from "./client.js";

const ipc = () => window.flashback ?? null;

/**
 * Identity of whatever the client is pointed at — local API or remote Flashback Server,
 * indistinguishable by design.
 * @returns {Promise<{vaultId, vaultName, appVersion, schemaVersion, canonicalVersion, capabilities}>}
 */
export function getVaultIdentity() {
  return request("GET", "/api/vault");
}

/** Remotes as the connected server knows them. Never includes credentials. */
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

/** Unregisters a vault. Never deletes anything on disk. */
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

/** Opens a directory picker and registers the chosen vault where it stands. */
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

/** Handshakes with a remote and returns its identity, without switching to it. */
export async function testRemote(id) {
  return (
    (await ipc()?.testRemote?.(id)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

/** Point the renderer at a remote Flashback Server; the local API keeps running idle. */
export async function connectRemote(id) {
  return (
    (await ipc()?.connectRemote?.(id)) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}

/** Point the renderer back at the local vault — the one route off a misconfigured server. */
export async function connectLocal() {
  return (
    (await ipc()?.connectLocal?.()) ?? {
      ok: false,
      error: "Not available outside the desktop app.",
    }
  );
}
