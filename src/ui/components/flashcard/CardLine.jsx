/**
 * CardLine — one card as a catalogue row: the front (two lines at most), then its
 * source, type, when it comes due and any health flag in small mono. `actions` show
 * on hover or focus, at the row's right. Used by Flashcards and Decks.
 *
 * `card` is a card-browser row: `frontText`, `name`, `card_type`, `document_path`
 * (null = the default deck), `gap`, `last_recall`, `flags`.
 */

import IconDecks from '../icons/IconDecks';
import getFileIcon from '../icons/fileIconMap';
import { cardTypeLabel } from './flashcardFields';
import { frontLine, docTitle, dueLabel, flagLabel } from './cardLineText.js';
import { useT } from '../../translations/index';
import './CardLine.css';

export default function CardLine({ card, onOpen, actions = null, className = '', style }) {
  const { t } = useT();
  const Icon = card.document_path ? getFileIcon(card.document_path) : IconDecks;
  const flag = card.flags ? card.flags.split(',')[0] : null;
  return (
    <div
      className={`card-line${className ? ` ${className}` : ''}`}
      style={style}
      role="listitem"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); onOpen?.(); } }}
    >
      <div className="card-line__front">{frontLine(card) || t('(empty card)')}</div>
      <div className="card-line__meta">
        <span className="card-line__src"><Icon size={12} />{card.document_path ? docTitle(card.document_path) : t('Cards')}</span>
        {' · '}{cardTypeLabel(card.card_type, t)}
        {' · '}{dueLabel(card, Date.now(), t)}
        {flag && <>{' · '}<span className={`card-line__flag card-line__flag--${flag}`}>{flagLabel(flag, t)}</span></>}
      </div>
      {actions && (
        <span className="card-line__actions" onClick={(e) => e.stopPropagation()} role="presentation">
          {actions}
        </span>
      )}
    </div>
  );
}
