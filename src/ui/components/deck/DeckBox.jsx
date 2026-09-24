/**
 * DeckBox — a deck drawn as a box of cards: up to four card tops peeking out of a
 * sleeve in the deck's colour, with the count printed large on the sleeve. The
 * default deck is kraft. `size="lg"` is the deck page's, `size="sm"` the document
 * margin's; the grid uses the default. `edge` tints the card tops' edge — the margin
 * colours them by the highlight's swatch, never by card type.
 *
 *   <DeckBox color="sage" count={42} />
 */

import './DeckBox.css';

export default function DeckBox({ color = 'kraft', count = 0, size = 'md', edge = null, className = '' }) {
  const tops = Math.min(4, count);
  const sleeve = color === 'kraft' ? 'var(--color-kraft)' : `var(--color-box-${color})`;
  return (
    <div className={`deck-box deck-box--${size}${className ? ` ${className}` : ''}`} style={{ '--sleeve': sleeve, ...(edge ? { '--edge': edge } : {}) }} aria-hidden="true">
      <div className="deck-box__peek">
        {Array.from({ length: Math.max(0, tops - 1) }, (_, i) => tops - 1 - i).map((k) => (
          <span key={k} className="deck-box__edge" style={{ '--k': k }} />
        ))}
        {tops > 0 && <span className="deck-box__front" />}
      </div>
      <div className="deck-box__sleeve">
        <span className="deck-box__n">{count}</span>
      </div>
    </div>
  );
}
