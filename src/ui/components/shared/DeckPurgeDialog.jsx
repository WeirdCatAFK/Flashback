/**
 * DeckPurgeDialog — confirms erasing a deck *and its cards*.
 *
 * Distinct from the plain "Delete deck" confirm, which only drops the deck and leaves
 * the cards alone. This one destroys content, so it states exactly what will go:
 *
 *  - standalone vs document-anchored counts, because deleting the latter takes cards
 *    out of the user's notes — a different kind of loss, and worth naming the files
 *  - cards another deck also holds, which survive unless the user opts in
 *
 * It can't use `useConfirm`: that resolves to a bare boolean and has nowhere to carry
 * the shared-cards choice.
 */

import { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import { getDeckContents } from '../../api/decks.js';
import './DeckPurgeDialog.css';

export default function DeckPurgeDialog({ deckHash, deckName, onCancel, onConfirm, busy = false, error = null }) {
    const [summary, setSummary] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [includeShared, setIncludeShared] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getDeckContents(deckHash)
            .then(s => { if (!cancelled) setSummary(s); })
            .catch(err => { if (!cancelled) setLoadError(err.message || 'Could not read the deck.'); });
        return () => { cancelled = true; };
    }, [deckHash]);

    // Everything shown is the *doomed* set, not the deck's contents: shared cards drop
    // out of the headline, the breakdown and the button together, so the numbers can
    // never disagree with each other.
    const doomed = summary
        ? (includeShared ? summary.total : summary.total - summary.shared)
        : 0;
    const doomedStandalone = summary
        ? summary.standalone - (includeShared ? 0 : summary.sharedStandalone)
        : 0;
    const doomedAnchored = summary
        ? summary.documentAnchored - (includeShared ? 0 : summary.sharedDocumentAnchored)
        : 0;

    const footer = (
        <div className="deck-purge__footer">
            <button type="button" className="deck-purge__btn" onClick={onCancel} disabled={busy}>
                Cancel
            </button>
            <button
                type="button"
                className="deck-purge__btn deck-purge__btn--danger"
                onClick={() => onConfirm(includeShared)}
                disabled={busy || !summary}
            >
                {busy
                    ? 'Deleting…'
                    : `Delete deck and ${doomed} card${doomed === 1 ? '' : 's'}`}
            </button>
        </div>
    );

    return (
        <Modal
            title={`Erase "${deckName}" and its cards?`}
            size="sm"
            dismissible={!busy}
            onClose={onCancel}
            footer={footer}
        >
            <div className="deck-purge">
                {loadError && <p className="deck-purge__error">{loadError}</p>}
                {error && <p className="deck-purge__error">{error}</p>}
                {!summary && !loadError && <p className="deck-purge__muted">Checking what&apos;s in this deck…</p>}

                {summary && (
                    <>
                        {summary.total === 0 && (
                            <p>This deck is empty. Only the deck itself will be removed.</p>
                        )}

                        {summary.total > 0 && doomed === 0 && (
                            <p className="deck-purge__lead">
                                No cards will be deleted — every card here is also in another deck.
                                Only the deck itself will be removed.
                            </p>
                        )}

                        {doomed > 0 && (
                            <>
                                <p className="deck-purge__lead">
                                    <strong>{doomed}</strong> card{doomed === 1 ? '' : 's'} will be permanently deleted:
                                </p>
                                <ul className="deck-purge__breakdown">
                                    {doomedStandalone > 0 && <li>{doomedStandalone} standalone</li>}
                                    {doomedAnchored > 0 && (
                                        <li>
                                            {doomedAnchored} from document
                                            {doomedAnchored === 1 ? '' : 's'} —{' '}
                                            <span className="deck-purge__docs">{summary.documents.join(', ')}</span>
                                        </li>
                                    )}
                                </ul>
                            </>
                        )}

                        {summary.shared > 0 && (
                            <label className="deck-purge__shared">
                                <input
                                    type="checkbox"
                                    checked={includeShared}
                                    onChange={(e) => setIncludeShared(e.target.checked)}
                                    disabled={busy}
                                />
                                <span>
                                    Also delete {summary.shared} card{summary.shared === 1 ? '' : 's'} that
                                    {summary.shared === 1 ? ' is' : ' are'} also in{' '}
                                    <strong>{summary.otherDecks.join(', ')}</strong>
                                    <span className="deck-purge__muted">
                                        {includeShared
                                            ? (summary.shared === 1
                                                ? ' — it will be destroyed there too.'
                                                : ' — they will be destroyed there too.')
                                            : (summary.shared === 1
                                                ? ' — left unchecked it survives, and is only unlinked from this deck.'
                                                : ' — left unchecked they survive, and are only unlinked from this deck.')}
                                    </span>
                                </span>
                            </label>
                        )}

                        <p className="deck-purge__muted deck-purge__seal">
                            Seal versions the deck and sidecar files, so this can be rolled back.
                        </p>
                    </>
                )}
            </div>
        </Modal>
    );
}
