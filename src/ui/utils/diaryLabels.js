/*
 Module to rename diary to logs because on a remote vault there is an ammount of access of an owner to the diary
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
            prefHint: t('Writes a per-day summary of your reviews (counts, pass rate, streak), and lets you add your own written reflections. Everyone studying here shares one history, and the server’s owner can read yours. Off by default.'),
        }
        : {
            title: t('Diary'),
            loading: t('Loading diary…'),
            prefLabel: t('Study diary'),
            prefHint: t('Writes a per-day summary of your reviews (counts, pass rate, streak), and lets you add your own written reflections. Off by default.'),
        };
}
