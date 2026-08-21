import { createPortal } from 'react-dom';
import { useT } from '../../translations';
import { useSession } from '../../sessionContext.js';
import './SelectionToolbar.css';

// A function of `t` rather than a module constant, so a language switch re-renders
// the labels; `key` and `cssVar` are stable identifiers and are never translated.
const highlightColors = (t) => [
  { key: 'amber', cssVar: '--color-hl-1', label: t('Highlight 1') },
  { key: 'green', cssVar: '--color-hl-2', label: t('Highlight 2') },
  { key: 'blue',  cssVar: '--color-hl-3', label: t('Highlight 3') },
  { key: 'pink',  cssVar: '--color-hl-4', label: t('Highlight 4') },
];

// Floating toolbar over a text selection. Two verbs:
//   • color dot — highlight the selection (the highlight IS the reference;
//     it appears in the Highlights tab and can anchor cards later)
//   • Card — highlight (default color) + open the New Card form anchored to it
// Renderers that can't persist highlights only get the Card verb.
export default function SelectionToolbar({ rect, onMakeCard, onHighlight, onUnhighlight, onClear }) {
  const { t } = useT();
  // The two halves of this toolbar are two different permissions. A Reader gets neither, and
  // then the toolbar itself is nothing but a popup that appears on every selection and does
  // nothing — so it does not appear at all.
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
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {onHighlight && mayHighlight && (
        <>
          {highlightColors(t).map(({ key, cssVar, label }) => (
            <button type="button"
              key={key}
              className="sel-color-dot"
              style={{ '--dot-color': `var(${cssVar})` }}
              title={t('Highlight — {color}', { color: label })}
              aria-label={t('Highlight: {color}', { color: label })}
              onClick={() => handleColor(key)}
            />
          ))}
          {onUnhighlight && (
            <button type="button"
              className="sel-color-dot sel-color-dot--clear"
              title={t('Remove highlight')}
              onClick={onUnhighlight}
              aria-label={t('Remove highlight')}
            >
              ×
            </button>
          )}
          <div className="sel-divider" />
        </>
      )}
      {mayMakeCard && (
        <button type="button" className="sel-btn sel-btn--card" onClick={onMakeCard}>
          {t('+ Card')}
        </button>
      )}
    </div>,
    document.body
  );
}
