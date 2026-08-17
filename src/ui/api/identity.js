import { request } from './client.js';

// The local user identity, split the way remotes are: reads over HTTP, writes over IPC.
//
// That is not an inconsistency. `user` lives in config.json, whose writers are split by
// ownership — the Electron main process owns that key. But what gets STAMPED is resolved
// by the API (override → global → derived), and asking the connected server keeps that
// precedence rule in one place instead of reimplementing it here.

const ipc = () => window.flashback ?? null;

/**
 * What the connected server would stamp on new work.
 * @returns {Promise<{name: string, email: string, source: 'vault'|'global'|'default', author: string}>}
 */
export function getEffectiveIdentity() {
    return request('GET', '/api/identity');
}

/**
 * What is stored, for the settings form: the global identity and this vault's override, if
 * any. Empty strings rather than nulls, so the form can bind to them directly.
 * `suggested` is what would be used if nothing were set — pure IPC, so it is available to
 * the setup wizard, which runs before the API process exists.
 *
 * @returns {Promise<{user: {name: string, email: string},
 *                    override: {name: string, email: string}|null,
 *                    suggested: {name: string, email: string},
 *                    activeVaultId: string|null}>}
 */
export async function getStoredIdentity() {
    return (await ipc()?.getIdentity?.()) ?? {
        user: { name: '', email: '' },
        override: null,
        suggested: { name: '', email: '' },
        activeVaultId: null,
    };
}

export async function setIdentity(identity) {
    return (await ipc()?.setIdentity?.(identity))
        ?? { ok: false, error: 'Not available outside the desktop app.' };
}

/** Passing null for `identity` clears this vault's override. */
export async function setVaultIdentity(vaultId, identity) {
    return (await ipc()?.setVaultIdentity?.(vaultId, identity))
        ?? { ok: false, error: 'Not available outside the desktop app.' };
}
