import { useState } from 'react';
import FlashcardForm from './FlashcardForm';
import Modal from './Modal';
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
        <Modal title="New standalone card" size="lg" onClose={onClose} dismissible={!saving}>
            <FlashcardForm
                saving={saving}
                error={error}
                onSubmit={handleSubmit}
                onCancel={onClose}
            />
        </Modal>
    );
}
