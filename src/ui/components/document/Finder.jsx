/**
 * Finder — a condensed, searchable index of the open document's cards and
 * highlights, over the document rather than beside it (Ctrl+F, or Find in the
 * reading strip). Choosing a row closes it and jumps to the passage; a card opens
 * in the card editor, a highlight takes a new card or is removed — confirmed in
 * the row when cards hang off it. Esc or a click outside closes it.
 *
 * Rows follow reading order (`readingOrder`; `domOrder` reads where Markdown's
 * inline marks sit, once, as the finder opens), so the cards of one passage sit
 * together and in the order the passages come. Hovering or focusing a row links it
 * (`onLink`): the passage glows in the text, its cards lift in the margin, and
 * every row of the same passage lights with it (`linkedId`).
 */

import { useEffect, useRef, useState } from 'react';
import InlineConfirm from '../base/InlineConfirm';
import { cardTypeShortLabel } from '../flashcard/flashcardFields';
import { cardFront, cardsByHighlight, cardMatches, highlightMatches, orderedCards, hlColor, readingOrder } from './finderRows.js';
import { useT } from '../../translations/index';
import './Finder.css';

export default function Finder({
  highlights = [], flashcards = [], canEditCards, canAnnotate,
  onClose, onJump, onAddCard, onEditCard, onRemove, removal, onResolveRemoval, onCancelRemoval,
  linkedId = null, onLink, domOrder,
}) {
  const { t, tp } = useT();
  const [tab, setTab] = useState('cards');
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);
  const [domIds] = useState(() => domOrder?.() ?? []);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current?.contains(e.target) || e.target.closest?.('.doc-reading-find, .card-bench, .popover')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const byHighlight = cardsByHighlight(flashcards);
  const ordered = readingOrder(highlights, domIds);
  const cards = orderedCards(flashcards, ordered).filter(({ card }) => cardMatches(card, query));
  const shownHighlights = ordered.filter((h) => highlightMatches(h, byHighlight.get(h.id), query));
  const jump = (id) => { if (!id) return; onClose(); onJump(id); };
  const linkProps = (id) => ({
    onPointerEnter: () => onLink?.(id ?? null),
    onPointerLeave: () => onLink?.(null),
    onFocus: () => onLink?.(id ?? null),
    onBlur: () => onLink?.(null),
  });
  const rowClass = (id) => `finder__row${id && id === linkedId ? ' is-linked' : ''}`;

  return (
    <div
      ref={ref}
      id="doc-finder"
      className="finder"
      role="dialog"
      aria-label={t('Find in this document')}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
    >
      <div className="finder__head">
        <input
          ref={inputRef}
          type="search"
          placeholder={t('Find cards and highlights')}
          aria-label={t('Find cards and highlights')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="finder__close" onClick={onClose} aria-label={t('Close')}>{t('Esc')}</button>
      </div>
      <div className="finder__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'cards'} onClick={() => setTab('cards')}>
          {t('Cards')} <span>{flashcards.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'highlights'} onClick={() => setTab('highlights')}>
          {t('Highlights')} <span>{highlights.length}</span>
        </button>
      </div>

      <div className="finder__body">
        {tab === 'cards' && (
          <>
            {cards.map(({ card, highlight }) => (
              <div
                key={card.globalHash ?? cardFront(card, t)}
                className={rowClass(highlight?.id)}
                {...linkProps(highlight?.id)}
                style={{ '--hl': highlight ? hlColor(highlight.color) : 'var(--color-border)' }}
                role="button"
                tabIndex={0}
                onClick={() => jump(highlight?.id)}
                onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); jump(highlight?.id); } }}
              >
                <i aria-hidden="true" />
                <div>
                  <div className="finder__text">{cardFront(card, t) || t('(empty card)')}</div>
                  <div className="finder__meta">
                    <span>
                      {cardTypeShortLabel(card.cardType ?? 'basic', t)}
                      {!highlight && <> · <span className="finder__orphan">{highlightIdOfLabel(card, t)}</span></>}
                    </span>
                    {canEditCards && card.globalHash && (
                      <span className="finder__actions" onClick={(e) => e.stopPropagation()} role="presentation">
                        <button type="button" className="link-action" onClick={() => onEditCard(card.globalHash)}>{t('Edit')}</button>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {cards.length === 0 && (
              <p className="finder__empty">
                {query ? t('No card matches.') : t('No cards yet. Select a passage and choose Card.')}
              </p>
            )}
          </>
        )}

        {tab === 'highlights' && (
          <>
            {shownHighlights.map((h) => {
              const own = byHighlight.get(h.id) ?? [];
              const confirming = removal?.from === 'finder' && removal.id === h.id;
              return (
                <div
                  key={h.id}
                  className={rowClass(h.id)}
                  {...linkProps(h.id)}
                  style={{ '--hl': hlColor(h.color) }}
                  role="button"
                  tabIndex={0}
                  onClick={() => !confirming && jump(h.id)}
                  onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); jump(h.id); } }}
                >
                  <i aria-hidden="true" />
                  <div>
                    <div className="finder__text">{h.text || t('(no text)')}</div>
                    {own.length > 0 && (
                      <div className="finder__sub">
                        {own.map((c) => <div key={c.globalHash ?? cardFront(c, t)}>{cardFront(c, t)}</div>)}
                      </div>
                    )}
                    {confirming ? (
                      <div onClick={(e) => e.stopPropagation()} role="presentation">
                        <InlineConfirm
                          title={tp('This passage has {n} card.', 'This passage has {n} cards.', removal.cardCount)}
                          message={t('Remove the highlight and keep them, or delete them with it.')}
                          onCancel={onCancelRemoval}
                          actions={[
                            { label: t('Keep cards'), onClick: () => onResolveRemoval(false) },
                            { label: t('Delete cards'), kind: 'danger', onClick: () => onResolveRemoval(true) },
                          ]}
                        />
                      </div>
                    ) : (
                      <div className="finder__meta">
                        <span>{own.length ? tp('{n} card', '{n} cards', own.length) : t('no card')}</span>
                        <span className="finder__actions" onClick={(e) => e.stopPropagation()} role="presentation">
                          {canEditCards && <button type="button" className="link-action" onClick={() => onAddCard(h.id)}>{t('Add card')}</button>}
                          {canAnnotate && <button type="button" className="link-action link-action--danger" onClick={() => onRemove(h.id)}>{t('Remove')}</button>}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {shownHighlights.length === 0 && (
              <p className="finder__empty">
                {query ? t('No highlight matches.') : t('No highlights yet. Select a passage and pick a colour.')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Why a card has no passage to jump to. */
function highlightIdOfLabel(card, t) {
  return card.vanillaData?.location?.type === 'highlight' ? t('passage removed') : t('no passage');
}
