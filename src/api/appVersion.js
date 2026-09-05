/**
 * The version of the Flashback build that is running.
 *
 * One owner, because it is read from two very different places — the `/api/vault` handshake
 * (where clients use it as half the compatibility contract) and the server's update check —
 * and because *finding* it is not trivial in every build:
 *
 *   - In the repo and inside `app.asar`, this module sits at `src/api/`, so the manifest is
 *     two levels up.
 *   - In the bundled standalone server the whole API is one file with its own `package.json`
 *     written beside it by `scripts/package-server.js`, and `../..` resolves outside the
 *     artifact entirely. That silently reported `appVersion: null` in the handshake once.
 *
 * Read once at import: the manifest never changes for the life of the process, and inside
 * `app.asar` it is readable but frozen.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** @type {string|null} */
export const APP_VERSION = (() => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of ['../../package.json', './package.json']) {
        try {
            const { version } = JSON.parse(readFileSync(path.join(here, candidate), 'utf-8'));
            if (version) return version;
        } catch { /* try the next location */ }
    }
    return null;
})();

export default APP_VERSION;
