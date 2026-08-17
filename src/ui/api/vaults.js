import { request } from './client.js';

// Vault and remote management.
//
// Unusually for this folder, most of these go over Electron IPC rather than HTTP. That is
// not an inconsistency — the registry and the remote credentials belong to the machine,
// not to any one vault, so they live in the main process. The two calls that DO go over
// HTTP describe whatever the app is currently connected to, which is exactly the kind of
// thing a remote must be able to answer for itself.

const ipc = () => window.flashback ?? null;

// --- Over HTTP: the connected server describes itself -----------------------

/**
 * Identity of whatever the client is pointed at — local API or remote Flashback Server,
 * indistinguishable by design.
 * @returns {Promise<{vaultId, vaultName, appVersion, schemaVersion, canonicalVersion, capabilities}>}
 */
export function getVaultIdentity() {
    return request('GET', '/api/vault');
}

/** Remotes as the connected server knows them. Never includes credentials. */
export function getServerRemotes() {
    return request('GET', '/api/remotes');
}

// --- Over IPC: this machine's registries ------------------------------------

export async function listVaults() {
    return (await ipc()?.listVaults?.()) ?? { activeVaultId: null, vaults: [] };
}

export async function createVault(name) {
    return (await ipc()?.createVault?.(name)) ?? { ok: false, error: 'Not available outside the desktop app.' };
}

export async function renameVault(id, name) {
    return (await ipc()?.renameVault?.(id, name)) ?? { ok: false, error: 'Not available outside the desktop app.' };
}

/** Unregisters a vault. Never deletes anything on disk. */
export async function removeVault(id) {
    return (await ipc()?.removeVault?.(id)) ?? { ok: false, error: 'Not available outside the desktop app.' };
}

export async function switchVault(id) {
    return (await ipc()?.switchVault?.(id)) ?? { ok: false, error: 'Not available outside the desktop app.' };
}

/** Opens a directory picker and registers the chosen vault where it stands. */
export async function openVaultFromDisk() {
    return (await ipc()?.openVaultFromDisk?.()) ?? { ok: false, error: 'Not available outside the desktop app.' };
}

export async function listRemotes() {
    return (await ipc()?.listRemotes?.()) ?? [];
}

export async function addRemote(remote) {
    return (await ipc()?.addRemote?.(remote)) ?? { ok: false, error: 'Not available outside the desktop app.' };
}

export async function removeRemote(id) {
    return (await ipc()?.removeRemote?.(id)) ?? { ok: false, error: 'Not available outside the desktop app.' };
}

/** Handshakes with a remote and returns its identity, without switching to it. */
export async function testRemote(id) {
    return (await ipc()?.testRemote?.(id)) ?? { ok: false, error: 'Not available outside the desktop app.' };
}
