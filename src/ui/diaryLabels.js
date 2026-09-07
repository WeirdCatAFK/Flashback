/**
 * What to call the per-day study record — and it has two honest names, not one.
 *
 * On a LOCAL vault it is a diary: the files sit on this machine, nobody else studies here,
 * and nobody else can read it. On a REMOTE Flashback Server it is not: `diary/` is one git
 * repo holding every account's summaries and prose, and an admin can read yours. Calling
 * that a diary promises privacy the deployment cannot deliver, so it is "Logs" there.
 *
 * Only the LABEL moves. The route is `/api/diary`, the directory is `diary/`, the
 * preference is `fb-diary-enabled` — renaming any of those would be a migration that
 * silently reset everyone's opt-in, and they are the same files either way.
 *
 * Every string is a literal in a function of `t`, called at render: a t() call at module
 * scope evaluates once at import and would keep the old language after a switch, and a
 * variable passed to t() never reaches scripts/translations-extract.js. Same shape as
 * `navLabels()` in App.jsx and `roleLabels.js`.
 *
 * `shared` comes from the connection, which App.jsx owns and prop-drills — `useConnection()`
 * subscribes to IPC, so calling it a second time in a leaf view would open a second
 * subscription rather than read the one that already exists.
 */

/** Is the vault we are pointed at one other people can also study in? */
export function isSharedVault(connection) {
    return connection?.kind === 'remote';
}

/**
 * @param {(s: string, v?: object) => string} t
 * @param {boolean} shared — true on a remote server (see isSharedVault)
 */
export function diaryLabels(t, shared) {
    return shared
        ? {
            title: t('Logs'),
            loading: t('Loading logs…'),
            prefLabel: t('Study log'),
            prefHint: t('Writes a per-day summary of your reviews (counts, pass rate, streak), and lets you add your own written reflections. Everyone studying here shares one history, and an administrator can read yours. Off by default.'),
        }
        : {
            title: t('Diary'),
            loading: t('Loading diary…'),
            prefLabel: t('Study diary'),
            prefHint: t('Writes a per-day summary of your reviews (counts, pass rate, streak), and lets you add your own written reflections. Off by default.'),
        };
}
