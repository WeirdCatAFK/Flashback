/**
 * SelectionToolbar — the floating toolbar over a text selection: highlight
 * colours, make a card, and remove — with its confirmation in place. Portaled to body and positioned from a
 * shell-layout rect (utils/uiZoom.js).
 */

import { createPortal } from 'react-dom';
import { useT } from '../../translations/index';
import { useSession } from '../../sessionContext.js';
import './SelectionToolbar.css';

/**
 * A function of `t` rather than a module constant, so a language switch re-renders
 * the labels; `key` and `cssVar` are stable identifiers and are never translated.
 */
const highlightColors = (t) => [
  { key: 'amber', cssVar: '--color-hl-1', label: t('Highlight 1') },
  { key: 'green', cssVar: '--color-hl-2', label: t('Highlight 2') },
  { key: 'blue',  cssVar: '--color-hl-3', label: t('Highlight 3') },
  { key: 'pink',  cssVar: '--color-hl-4', label: t('Highlight 4') },
];

/**
 * Floating toolbar over a text selection or an existing highlight: the colour
 * swatches (paint, or recolour), Card (highlight in the default colour, then open
 * the card editor anchored to it), and Remove on a highlight. Removing a highlight
 * that cards hang off asks first, in the toolbar itself — keep the cards, delete
 * them with it, or cancel — rather than in a dialog over the document. Over a
 * clicked highlight, `currentColor` marks its swatch as the one it has.
 * Renderers that can't persist highlights only get Card.
 */
export default function SelectionToolbar({ rect, currentColor = null, onMakeCard, onHighlight, onUnhighlight, removal = null, onResolveRemoval, onCancelRemoval, onClear }) {
  const { t, tp } = useT();
  const { can } = useSession();
  const mayHighlight = can('annotate');
  const mayMakeCard  = can('editCards');
  const top = rect.top - 42;
  const left = rect.left + rect.width / 2;

  const handleColor = (key) => {
    if (onHighlight) onHighlight(key);
    else onClear?.();
  };

  if (!mayHighlight && !mayMakeCard) return null;

  return createPortal(
    <div
      className="selection-toolbar"
      role="toolbar"
      aria-label={t('Highlight')}
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {removal ? (
        <>
          <span className="sel-confirm-text">{tp('This passage has {n} card.', 'This passage has {n} cards.', removal.cardCount)}</span>
          <button type="button" className="sel-btn" onClick={() => onResolveRemoval(false)}>{t('Keep cards')}</button>
          <button type="button" className="sel-btn sel-btn--danger" onClick={() => onResolveRemoval(true)}>{t('Delete cards')}</button>
          <button type="button" className="sel-btn" onClick={onCancelRemoval}>{t('Cancel')}</button>
        </>
      ) : (
        <>
          {onHighlight && mayHighlight && (
            <>
              {highlightColors(t).map(({ key, cssVar, label }) => (
                <button type="button"
                  key={key}
                  className="sel-color-dot"
                  aria-pressed={currentColor ? currentColor === key : undefined}
                  style={{ '--dot-color': `var(${cssVar})` }}
                  title={t('Highlight — {color}', { color: label })}
                  aria-label={t('Highlight: {color}', { color: label })}
                  onClick={() => handleColor(key)}
                />
              ))}
              <div className="sel-divider" />
            </>
          )}
          {mayMakeCard && (
            <button type="button" className="sel-btn" onClick={onMakeCard}>
              {t('Card')}
            </button>
          )}
          {onHighlight && mayHighlight && onUnhighlight && (
            <button type="button" className="sel-btn sel-btn--danger" onClick={onUnhighlight}>
              {t('Remove')}
            </button>
          )}
        </>
      )}
    </div>,
    document.body
  );
}
