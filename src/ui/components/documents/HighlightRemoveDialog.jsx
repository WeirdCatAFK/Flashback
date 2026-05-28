import { createPortal } from 'react-dom';
import './HighlightRemoveDialog.css';

export default function HighlightRemoveDialog({ cardCount, onCancel, onKeepCards, onDeleteCards }) {
  return createPortal(
    <div className="hl-dialog-backdrop" onClick={onCancel}>
      <div className="hl-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="hl-dialog-title">Remove this highlight?</h3>
        <p className="hl-dialog-body">
          {cardCount} flashcard{cardCount === 1 ? '' : 's'} {cardCount === 1 ? 'is' : 'are'} anchored
          to this highlight. Removing it will sever the anchor.
        </p>
        <div className="hl-dialog-actions">
          <button className="hl-btn" onClick={onCancel}>Cancel</button>
          <button className="hl-btn hl-btn--primary" onClick={onKeepCards}>
            Remove highlight, keep cards
          </button>
          <button className="hl-btn hl-btn--danger" onClick={onDeleteCards}>
            Remove + delete cards
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
