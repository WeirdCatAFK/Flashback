/**
 * HighlightRemoveDialog — asked before removing a highlight that cards are
 * anchored to: keep the cards (severing the anchor) or delete them with it.
 */

import Modal from '../base/Modal';
import { useT } from '../../translations/index';

export default function HighlightRemoveDialog({ cardCount, onCancel, onKeepCards, onDeleteCards }) {
  const { t, tp } = useT();
  return (
    <Modal
      title={t('Remove this highlight?')}
      size="sm"
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel}>{t('Cancel')}</button>
          <button type="button" className="btn btn--primary" onClick={onKeepCards}>{t('Remove highlight, keep cards')}</button>
          <button type="button" className="btn btn--danger" onClick={onDeleteCards}>{t('Remove + delete cards')}</button>
        </>
      }
    >
      <p>
        {tp('{n} flashcard is anchored to this highlight. Removing it will sever the anchor.',
          '{n} flashcards are anchored to this highlight. Removing it will sever the anchor.',
          cardCount)}
      </p>
    </Modal>
  );
}
