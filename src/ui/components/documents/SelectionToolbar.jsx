import { createPortal } from 'react-dom';
import './SelectionToolbar.css';

const HIGHLIGHT_COLORS = [
  { key: 'amber', cssVar: '--color-hl-1', label: 'Highlight 1' },
  { key: 'green', cssVar: '--color-hl-2', label: 'Highlight 2' },
  { key: 'blue',  cssVar: '--color-hl-3', label: 'Highlight 3' },
  { key: 'pink',  cssVar: '--color-hl-4', label: 'Highlight 4' },
];

export default function SelectionToolbar({ rect, onMakeCard, onMakeRef, onHighlight, onUnhighlight, onClear }) {
  const top = rect.top - 42;
  const left = rect.left + rect.width / 2;

  const handleColor = (key) => {
    if (onHighlight) onHighlight(key);
    else onClear?.();
  };

  return createPortal(
    <div
      className="selection-toolbar"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {HIGHLIGHT_COLORS.map(({ key, cssVar, label }) => (
        <button type="button"
          key={key}
          className="sel-color-dot"
          style={{ background: `var(${cssVar})` }}
          title={`Highlight — ${label}`}
          aria-label={`Highlight: ${label}`}
          onClick={() => handleColor(key)}
        />
      ))}
      {onUnhighlight && (
        <button type="button"
          className="sel-color-dot sel-color-dot--clear"
          title="Remove highlight"
          onClick={onUnhighlight}
          aria-label="Remove highlight"
        >
          ×
        </button>
      )}
      <div className="sel-divider" />
      <button type="button" className="sel-btn sel-btn--card" onClick={onMakeCard}>Card</button>
      <button type="button" className="sel-btn" onClick={onMakeRef ?? onClear}>Ref</button>
    </div>,
    document.body
  );
}
