export const version = 1;
export const description = 'type_answer: move the compared answer from backText into answerText';

export function splitCard(card) {
    if (card?.cardType !== 'type_answer') return false;
    const vd = card.vanillaData;
    if (!vd || typeof vd !== 'object') return false;
    if (vd.answerText != null) return false;

    vd.answerText = vd.backText ?? '';
    vd.backText = '';
    return true;
}

export function up(meta, kind) {
    if (kind === 'document') {
        const cards = Array.isArray(meta.flashcards) ? meta.flashcards : [];
        return cards.reduce((changed, card) => splitCard(card) || changed, false);
    }

    if (kind === 'deck') {
        const entries = Array.isArray(meta.entries) ? meta.entries : [];
        return entries.reduce((changed, e) => (e?.card ? splitCard(e.card) : false) || changed, false);
    }

    return false;
}

export async function derived(query) {
    return await query.backfillTypeAnswerAnswerText();
}
