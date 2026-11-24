export const READ_FIELDS = ['unit', 'total', 'pos', 'pos_pct', 'far', 'far_pct', 'body_etag'];

export function scoped(scope) {
    if (typeof scope !== 'string' || scope.length === 0) {
        throw new Error(
            'resources/db: this call needs an account scope (an account id, or OWNER_SCOPE). '
            + 'Resolve it once at the module boundary with requestContext.currentScope().'
        );
    }
    return scope;
}

export const highlightAnchor = (card) => {
    const loc = card?.vanillaData?.location;
    return loc?.type === 'highlight' && typeof loc.id === 'string' ? loc.id : null;
};

export const LIVE_ANCHOR_SQL = 'SELECT 1 FROM Highlights hl WHERE hl.global_hash = f.highlight_hash';

export const PROGRESS_KEYS = [
    'level', 'sm2Reps', 'lastRecall', 'fsrsStability', 'fsrsDifficulty',
    'fsrsDue', 'fsrsState', 'fsrsReps', 'fsrsLapses',
];

export const PROGRESS_JOIN = (cardAlias = 'f', progressAlias = 'p') =>
    `LEFT JOIN progress.CardProgress ${progressAlias} ON ${progressAlias}.card_hash = ${cardAlias}.global_hash AND ${progressAlias}.account_id = ?`;

export const CARD_LEARNED_SQL = (t) => `
    CASE
      WHEN ${t}.fsrs_stability IS NOT NULL THEN
        CASE WHEN ${t}.fsrs_stability >= 180 THEN 1.00
             WHEN ${t}.fsrs_stability >=  90 THEN 0.90
             WHEN ${t}.fsrs_stability >=  30 THEN 0.75
             WHEN ${t}.fsrs_stability >=  14 THEN 0.60
             WHEN ${t}.fsrs_stability >=   7 THEN 0.45
             WHEN ${t}.fsrs_stability >=   3 THEN 0.30
             WHEN ${t}.fsrs_stability >=   1 THEN 0.15
             ELSE 0.05 END
      ELSE MIN(1.0, COALESCE(${t}.level, 0) / 6.0)
    END`;

export function carriesTagSql(op = '=') {
    return `(EXISTS (
            SELECT 1 FROM Connections ctag
            JOIN Tags tg ON tg.node_id = ctag.destiny_id
            WHERE ctag.origin_id = f.node_id
              AND ctag.type_id = (SELECT id FROM ConnectionTypes WHERE name = 'tag')
              AND tg.name ${op} ?
        ) OR EXISTS (
            SELECT 1 FROM InheritedTags it
            JOIN Connections cinh ON cinh.id = it.connection_id
            JOIN Tags tgi ON tgi.id = it.tag_id
            WHERE cinh.destiny_id = f.node_id
              AND cinh.type_id IN (SELECT id FROM ConnectionTypes WHERE name IN ('inheritance', 'deck'))
              AND tgi.name ${op} ?
        ))`;
}

export function cardMatchSql(text) {
    const term = `%${text}%`;
    return {
        sql: `(c.frontText LIKE ? OR c.backText LIKE ? OR c.answerText LIKE ? OR c.custom_html LIKE ? OR f.name LIKE ?
            OR f.global_hash IN (SELECT de.card_hash FROM DeckEntries de JOIN Decks dk ON dk.id = de.deck_id WHERE dk.name LIKE ?)
            OR f.document_id IN (SELECT id FROM Documents WHERE name LIKE ?)
            OR ${carriesTagSql('LIKE')})`,
        params: [term, term, term, term, term, term, term, term, term],
    };
}

export function escapeLike(str) {
    return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
