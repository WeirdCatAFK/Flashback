export function isSharedVault(connection) {
    return connection?.kind === 'remote';
}

export function diaryLabels(t, shared) {
    return shared
        ? {
            title: t('Logs'),
            loading: t('Loading logs…'),
            prefLabel: t('Study log'),
            prefHint: t('Writes a per-day summary of your reviews (counts, pass rate, streak), and lets you add your own written reflections. Flashback shows what you write only to you. The server’s owner can see your daily summaries. Off by default.'),
        }
        : {
            title: t('Diary'),
            loading: t('Loading diary…'),
            prefLabel: t('Study diary'),
            prefHint: t('Writes a per-day summary of your reviews (counts, pass rate, streak), and lets you add your own written reflections. Off by default.'),
        };
}
