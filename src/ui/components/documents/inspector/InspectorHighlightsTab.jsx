const COLOR_VAR = {
  amber: '--color-hl-amber',
  green: '--color-hl-green',
  blue:  '--color-hl-blue',
  pink:  '--color-hl-pink',
};

export default function InspectorHighlightsTab({ highlights = [], flashcards = [], onJump }) {
  // Count cards anchored to each highlight, so we can show the link count
  // without re-scanning per item.
  const cardCounts = new Map();
  for (const card of flashcards) {
    const loc = card?.vanillaData?.location;
    if (loc?.type === 'highlight' && loc?.id) {
      cardCounts.set(loc.id, (cardCounts.get(loc.id) ?? 0) + 1);
    }
  }

  if (highlights.length === 0) {
    return (
      <div className="cards-tab">
        <div className="cards-tab-header">
          <span className="cards-tab-count">0 highlights</span>
        </div>
        <p className="inspector-placeholder">No highlights yet.</p>
      </div>
    );
  }

  return (
    <div className="cards-tab">
      <div className="cards-tab-header">
        <span className="cards-tab-count">
          {highlights.length} highlight{highlights.length === 1 ? '' : 's'}
        </span>
      </div>

      {highlights.map((h) => {
        const cardCount = cardCounts.get(h.id) ?? 0;
        const cssVar = COLOR_VAR[h.color] ?? COLOR_VAR.amber;
        return (
          <button
            key={h.id}
            className="card-item hl-item"
            onClick={() => onJump?.(h.id)}
            title="Jump to highlight"
          >
            <div className="card-item-header">
              <span
                className="hl-item-dot"
                style={{ background: `var(${cssVar})` }}
              />
              {cardCount > 0 && (
                <span className="card-item-level">
                  {cardCount} card{cardCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <p className="card-item-front hl-item-text">{h.text || '(empty)'}</p>
          </button>
        );
      })}
    </div>
  );
}
