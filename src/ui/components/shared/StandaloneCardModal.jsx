import { useState } from 'react';
import FlashcardForm from './FlashcardForm';
import { createStandaloneCard } from '../../api/decks';
import './StandaloneCardModal.css';

export default function StandaloneCardModal({ onClose, onCreated }) {
    const [saving, setSaving] = useState(false);
    const [error, setError]   = useState(null);

    const handleSubmit = async ({ card }) => {
        setSaving(true);
        setError(null);
        try {
            await createStandaloneCard({
                frontText:  card.vanillaData?.frontText  || null,
                backText:   card.vanillaData?.backText   || null,
                name:       card.name                    || null,
                cardType:   card.cardType,
                category:   card.category                || null,
                customHtml: card.customData?.html        || null,
            });
            onCreated();
        } catch (err) {
            setError(err.message ?? 'Failed to create card');
            setSaving(false);
        }
    };

    return (
        <div className="sc-modal-backdrop" onClick={onClose}>
            <div className="sc-modal" onClick={e => e.stopPropagation()}>
                <div className="sc-modal-header">
                    <span className="sc-modal-title">New standalone card</span>
                    <button className="sc-modal-close" onClick={onClose} type="button">✕</button>
                </div>
                <div className="sc-modal-body">
                    <FlashcardForm
                        saving={saving}
                        error={error}
                        onSubmit={handleSubmit}
                        onCancel={onClose}
                    />
                </div>
            </div>
        </div>
    );
}
