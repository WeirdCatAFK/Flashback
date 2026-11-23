import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const APP_VERSION = (() => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const candidate of ['../../package.json', './package.json']) {
        try {
            const { version } = JSON.parse(readFileSync(path.join(here, candidate), 'utf-8'));
            if (version) return version;
        } catch {}
    }
    return null;
})();

export default APP_VERSION;
