/** The characters that Windows rejects in a path component. */
// eslint-disable-next-line no-control-regex
export const INVALID_NAME = /[<>:"/\\|?*\x00-\x1f]/;

export const MAX_NAME_LENGTH = 64;

export const RESERVED_NAMES = new Set([
    'config.json', 'accounts.db', 'logs',
    'cache', 'code cache', 'gpucache', 'dawncache', 'shadercache', 'graphitedawncache',
    'local storage', 'session storage', 'shared dictionary', 'network',
    'indexeddb', 'databases', 'blob_storage', 'partitions', 'crashpad',
]);

export function vaultNameError(name) {
    const v = (name ?? '').trim();
    if (!v) return 'required';
    if (INVALID_NAME.test(v)) return 'invalid-chars';
    if (v.length > MAX_NAME_LENGTH) return 'too-long';
    if (/[. ]$/.test(v)) return 'trailing-dot';
    if (RESERVED_NAMES.has(v.toLowerCase())) return 'reserved';
    return null;
}
