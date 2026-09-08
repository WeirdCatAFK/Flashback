/**
 * updateCheck.js — does a newer Flashback release exist?
 *
 * The desktop app has had this since the beta (`src/electron/updater.js`, electron-updater in
 * notify-first mode). The headless build had nothing at all: a container or a zip on somebody
 * else's machine had no way to learn that a release had happened, and `docs/SERVER.md` cheerfully
 * told its operator to `docker compose pull` without ever telling them when to.
 *
 * **Notify only. This never updates anything, and that is not a stopgap.** The process holds the
 * only copy of the workspace, migrations are one-way (010 drops columns an older build reads),
 * and a server restarting itself takes every connected reader down with it. Deciding when to
 * upgrade is the operator's job; knowing there is something to decide about is ours.
 *
 * Deliberately small:
 *
 *   - It asks GitHub for the latest *published* release. Draft and prerelease are excluded by
 *     that endpoint, which matches `electron-updater`'s rule on the desktop — so both halves of
 *     the product consider the same set of releases to exist.
 *   - It goes through `safeFetch`, the one door out to the open web. api.github.com is public,
 *     so no `allowPrivate` is involved; using the guard anyway means a redirect onto the
 *     deployment's own network cannot happen here either.
 *   - Every failure is a warning and nothing else. A rate limit, a DNS hiccup or an air-gapped
 *     network must never affect a boot, so the result stays null and the next tick tries again.
 *
 * Off with `FLASHBACK_UPDATE_CHECK=off`, in which case no outbound request is made at all.
 */

import process from 'process';
import { safeFetch } from '../api/access/resources/safeFetch.js';

const RELEASES_URL = 'https://api.github.com/repos/WeirdCatAFK/Flashback/releases/latest';

/** Same cadence as the desktop checker: once at boot, then daily. */
const DAY_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 8000;

/**
 * Compares two versions the way a release ladder means them.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1} negative if `a` is older than `b`.
 */
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

/** Whether the environment asked for this at all. Anything but `off`/`false`/`0` is on. */
export function updateCheckEnabled(env = process.env) {
    const raw = String(env.FLASHBACK_UPDATE_CHECK ?? '').trim().toLowerCase();
    return !(raw === 'off' || raw === 'false' || raw === '0' || raw === 'no');
}

/**
 * Starts the checker and returns a getter for whatever it last learned.
 *
 * @param {object}  options
 * @param {string}  options.currentVersion  what this build is.
 * @param {boolean} [options.enabled]
 * @returns {{ status: () => object|null, stop: () => void }}
 */
export function startUpdateCheck({ currentVersion, enabled = updateCheckEnabled() }) {
    /** @type {{current: string, latest: string|null, available: boolean, url: string|null, checkedAt: string}|null} */
    let last = null;

    if (!enabled) {
        console.log('Update check is off (FLASHBACK_UPDATE_CHECK). No release check will be made.');
        return { status: () => null, stop: () => {} };
    }

    /** Asks GitHub for the latest release and logs a notice; never downloads. */
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
