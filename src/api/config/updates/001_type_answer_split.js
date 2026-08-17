// Canonical update 001 — type_answer: split the compared answer out of backText
//
// A type_answer card used to keep its expected answer in `backText`, which is also the text
// its back face renders. That conflation left nowhere to put a mnemonic or an explanation:
// anything added to the back changed what the reviewer's typing was compared against.
// `answerText` is now the compared value and `backText` is free prose shown after checking.
//
// Paired with schema migration 008, which adds the `FlashcardContent.answerText` column and
// backfills the derived rows. This half rewrites the canonical files, which a schema
// migration structurally cannot do.
//
// Idempotency: a card that already carries an `answerText` is left alone. That is what makes
// it safe for the runner to hand this update a file it may have already migrated — a card
// created by a current build, a sidecar restored by a Seal rollback, a vault whose files
// arrived from another machine.
//
// ONE-WAY (see UPDATES.md § One-way updates). Emptying `backText` is what a build released
// before `answerText` cannot survive: its Trainer grades the typed input against `backText`,
// so every migrated card becomes unanswerable there, and its standalone-card writer rebuilds
// vanillaData from {frontText, backText, media} — dropping `answerText` on the next edit and
// taking the answer with it. Accepted deliberately rather than kept dual-written: leaving the
// answer in both fields would mean "notes that equal the answer are not notes", a rule every
// reader would have to carry forever to buy compatibility with a version nobody should run.
// Recorded for the user in CHANGELOG.md; the reverse is a Seal rollback, not a down().

export const version = 1;
export const description = 'type_answer: move the compared answer from backText into answerText';

/**
 * Splits one card. Exported so the runner's callers (and the tests) can reason about a
 * single card without walking a vault.
 * @param {object} card a flashcard as stored in a sidecar or a deck entry snapshot
 * @returns {boolean} true when the card was changed
 */
export function splitCard(card) {
    if (card?.cardType !== 'type_answer') return false;
    const vd = card.vanillaData;
    if (!vd || typeof vd !== 'object') return false;
    if (vd.answerText != null) return false;

    vd.answerText = vd.backText ?? '';
    vd.backText = '';
    return true;
}

/**
 * @param {object} meta the parsed canonical file — a sidecar's metadata, or a deck file
 * @param {'document'|'folder'|'deck'} kind
 * @returns {boolean} true when the file was changed
 */
export function up(meta, kind) {
    if (kind === 'document') {
        const cards = Array.isArray(meta.flashcards) ? meta.flashcards : [];
        return cards.reduce((changed, card) => splitCard(card) || changed, false);
    }

    if (kind === 'deck') {
        const entries = Array.isArray(meta.entries) ? meta.entries : [];
        return entries.reduce((changed, e) => (e?.card ? splitCard(e.card) : false) || changed, false);
    }

    // Folder sidecars hold no cards.
    return false;
}

/**
 * Brings the derived index in line after the canonical files have been rewritten.
 *
 * Migration 008 already did this on the upgrade path, but the two halves must not depend on
 * running in the same session: a Vault Doctor rebuild in between re-derives the old shape
 * from whatever the files said at the time.
 */
export async function derived(query) {
    return await query.backfillTypeAnswerAnswerText();
}
