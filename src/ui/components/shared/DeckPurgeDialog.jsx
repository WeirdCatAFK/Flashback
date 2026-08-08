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
import { useT } from '../../translations';
import './DeckPurgeDialog.css';

export default function DeckPurgeDialog({ deckHash, deckName, onCancel, onConfirm, busy = false, error = null }) {
    const [summary, setSummary] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [includeShared, setIncludeShared] = useState(false);
    const { t, tp } = useT();

    useEffect(() => {
        let cancelled = false;
        getDeckContents(deckHash)
            .then(s => { if (!cancelled) setSummary(s); })
            // Wrapped in an object so an error with no message is still truthy here
            // and its fallback text can be translated at render rather than frozen now.
            .catch(err => { if (!cancelled) setLoadError({ message: err.message || null }); });
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
                {t('Cancel')}
            </button>
            <button
                type="button"
                className="deck-purge__btn deck-purge__btn--danger"
                onClick={() => onConfirm(includeShared)}
                disabled={busy || !summary}
            >
                {busy
                    ? t('Deleting…')
                    : tp('Delete deck and {n} card', 'Delete deck and {n} cards', doomed)}
            </button>
        </div>
    );

    return (
        <Modal
            title={t('Erase “{name}” and its cards?', { name: deckName })}
            size="sm"
            dismissible={!busy}
            onClose={onCancel}
            footer={footer}
        >
            <div className="deck-purge">
                {loadError && <p className="deck-purge__error">{loadError.message ?? t('Could not read the deck.')}</p>}
                {error && <p className="deck-purge__error">{error}</p>}
                {!summary && !loadError && <p className="deck-purge__muted">{t('Checking what’s in this deck…')}</p>}

                {summary && (
                    <>
                        {summary.total === 0 && (
                            <p>{t('This deck is empty. Only the deck itself will be removed.')}</p>
                        )}

                        {summary.total > 0 && doomed === 0 && (
                            <p className="deck-purge__lead">
                                {t('No cards will be deleted — every card here is also in another deck. Only the deck itself will be removed.')}
                            </p>
                        )}

                        {doomed > 0 && (
                            <>
                                <p className="deck-purge__lead">
                                    {tp('{n} card will be permanently deleted:', '{n} cards will be permanently deleted:', doomed)}
                                </p>
                                <ul className="deck-purge__breakdown">
                                    {doomedStandalone > 0 && <li>{t('{n} standalone', { n: doomedStandalone })}</li>}
                                    {doomedAnchored > 0 && (
                                        <li>
                                            {tp('{n} from document', '{n} from documents', doomedAnchored)} —{' '}
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
                                    {tp('Also delete {n} card that is also in', 'Also delete {n} cards that are also in', summary.shared)}{' '}
                                    <strong>{summary.otherDecks.join(', ')}</strong>
                                    <span className="deck-purge__muted">
                                        {' '}
                                        {includeShared
                                            ? tp('— it will be destroyed there too.',
                                                 '— they will be destroyed there too.', summary.shared)
                                            : tp('— left unchecked it survives, and is only unlinked from this deck.',
                                                 '— left unchecked they survive, and are only unlinked from this deck.', summary.shared)}
                                    </span>
                                </span>
                            </label>
                        )}

                        <p className="deck-purge__muted deck-purge__seal">
                            {t('Seal versions the deck and sidecar files, so this can be rolled back.')}
                        </p>
                    </>
                )}
            </div>
        </Modal>
    );
}
