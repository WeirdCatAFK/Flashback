import { createPortal } from 'react-dom';
import { useT } from '../../translations';
import './HighlightRemoveDialog.css';

export default function HighlightRemoveDialog({ cardCount, onCancel, onKeepCards, onDeleteCards }) {
  const { t, tp } = useT();
  return createPortal(
    <div className="hl-dialog-backdrop" onClick={onCancel} aria-hidden="true">
      <div className="hl-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="hl-dialog-title">{t('Remove this highlight?')}</h3>
        <p className="hl-dialog-body">
          {tp('{n} flashcard is anchored to this highlight. Removing it will sever the anchor.',
            '{n} flashcards are anchored to this highlight. Removing it will sever the anchor.',
            cardCount)}
        </p>
        <div className="hl-dialog-actions">
          <button type="button" className="hl-btn" onClick={onCancel}>{t('Cancel')}</button>
          <button type="button" className="hl-btn hl-btn--primary" onClick={onKeepCards}>
            {t('Remove highlight, keep cards')}
          </button>
          <button type="button" className="hl-btn hl-btn--danger" onClick={onDeleteCards}>
            {t('Remove + delete cards')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
