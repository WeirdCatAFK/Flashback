import { createPortal } from 'react-dom';
import './SelectionToolbar.css';

const HIGHLIGHT_COLORS = [
  { key: 'amber', cssVar: '--color-hl-amber', label: 'Highlight 1' },
  { key: 'green', cssVar: '--color-hl-green', label: 'Highlight 2' },
  { key: 'blue',  cssVar: '--color-hl-blue',  label: 'Highlight 3' },
  { key: 'pink',  cssVar: '--color-hl-pink',  label: 'Highlight 4' },
];

export default function SelectionToolbar({ rect, onMakeCard, onMakeRef, onClear }) {
  const top = rect.top - 42;
  const left = rect.left + rect.width / 2;

  return createPortal(
    <div
      className="selection-toolbar"
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {HIGHLIGHT_COLORS.map(({ key, cssVar, label }) => (
        <button
          key={key}
          className="sel-color-dot"
          style={{ background: `var(${cssVar})` }}
          title={`Highlight — ${label}`}
          onClick={onClear}
        />
      ))}
      <div className="sel-divider" />
      <button className="sel-btn sel-btn--card" onClick={onMakeCard}>Card</button>
      <button className="sel-btn" onClick={onMakeRef ?? onClear}>Ref</button>
    </div>,
    document.body
  );
}
