import process from 'process';
import { safeFetch } from '../api/access/resources/safeFetch.js';

const RELEASES_URL = 'https://api.github.com/repos/WeirdCatAFK/Flashback/releases/latest';

const DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 8000;

export function compareVersions(a, b) {
    const parse = (v) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/.exec(String(v ?? '').trim());
        return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] ?? null } : null;
    };
    const x = parse(a);
    const y = parse(b);
    if (!x || !y) return 0;

    for (let i = 0; i < 3; i++) {
        if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
    }
    if (x.pre && !y.pre) return -1;
    if (!x.pre && y.pre) return 1;
    return 0;
}

export function updateCheckEnabled(env = process.env) {
    const raw = String(env.FLASHBACK_UPDATE_CHECK ?? '').trim().toLowerCase();
    return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'no');
}

export function startUpdateCheck({ currentVersion, enabled = updateCheckEnabled() }) {
    let last = null;

    if (!enabled) {
        console.log('Update check is off (FLASHBACK_UPDATE_CHECK). No release check will be made.');
        return { status: () => null, stop: () => {} };
    }

    async function check() {
        const response = await safeFetch(RELEASES_URL, {
            headers: {
                'User-Agent': `Flashback-Server/${currentVersion}`,
                Accept: 'application/vnd.github+json',
            },
        });
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`);

        const release = await response.json();
        const latest = String(release?.tag_name ?? '').replace(/^v/, '') || null;
        const available = latest ? compareVersions(currentVersion, latest) < 0 : false;

        last = {
            current: currentVersion,
            latest,
            available,
            url: release?.html_url ?? null,
            checkedAt: new Date().toISOString(),
        };

        if (available) {
            console.log(
                `\nA newer Flashback release is available: ${latest} (this server runs ${currentVersion}).` +
                `\n  ${last.url}` +
                '\n  Nothing has been downloaded. See docs/SERVER.md § Upgrading, and snapshot the' +
                '\n  volume first — migrations are one-way.\n',
            );
        }
    }

    const tick = () => {
        check().catch((err) => {
            console.warn(`Update check failed: ${err?.message || err}`);
        });
    };

    const startup = setTimeout(tick, STARTUP_DELAY_MS);
    const daily = setInterval(tick, DAY_MS);
    startup.unref?.();
    daily.unref?.();

    return {
        status: () => last,
        stop: () => { clearTimeout(startup); clearInterval(daily); },
    };
}

export default startUpdateCheck;
