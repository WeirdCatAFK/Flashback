// Vault-name rules, shared by the renderer (Setup wizard, vault management UI) and the
// Electron main process (create/rename IPC).
//
// Plain JS with no Node or Electron imports on purpose: Vite bundles it into the renderer
// and main imports it directly, so there is exactly one definition of what a legal vault
// name is. It used to live only in Setup.jsx, which meant Config's vault-name field —
// the one that actually renamed a folder on disk — validated nothing at all.
//
// Returns a CODE rather than a sentence, because the renderer runs the result through
// t() for translation and main writes it to a log.

// The control-character range is intentional — these are the characters Windows rejects
// in a path component, and \x00-\x1f is part of that set.
// eslint-disable-next-line no-control-regex
export const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/;

export const MAX_NAME_LENGTH = 64;

// A vault is a directory inside the app's userData folder, so its name cannot collide
// with something Electron or the app already keeps there. `config.json` and `logs` are
// ours; the rest are Chromium's own state directories, and a vault that shadowed one
// would be corrupted by the browser process rather than by anything Flashback does.
export const RESERVED_NAMES = new Set([
    'config.json', 'logs',
    'cache', 'code cache', 'gpucache', 'dawncache', 'shadercache', 'graphitedawncache',
    'local storage', 'session storage', 'shared dictionary', 'network',
    'indexeddb', 'databases', 'blob_storage', 'partitions', 'crashpad',
]);

/**
 * @param {string} name
 * @returns {'required'|'invalid-chars'|'too-long'|'reserved'|'trailing-dot'|null}
 *          null when the name is usable.
 */
export function vaultNameError(name) {
    const v = (name ?? '').trim();
    if (!v) return 'required';
    if (INVALID_NAME.test(v)) return 'invalid-chars';
    if (v.length > MAX_NAME_LENGTH) return 'too-long';
    // Windows silently strips a trailing dot or space from a directory name, so the folder
    // created would not be the one asked for — and the mismatch only surfaces later, as a
    // vault that cannot be found.
    if (/[. ]$/.test(v)) return 'trailing-dot';
    if (RESERVED_NAMES.has(v.toLowerCase())) return 'reserved';
    return null;
}
