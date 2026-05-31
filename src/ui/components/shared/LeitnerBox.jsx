import { forwardRef, useEffect, useState } from 'react';
import './LeitnerBox.css';

// A skeuomorphic open Leitner box that "receives" a card. Purely presentational:
// the parent bumps `pulse` (a monotonically increasing counter) each time a card
// lands here, which replays the receive animation (flaps flap, body bounces, a
// tone-colored glow flashes). `tone` selects the review swatch used for the glow.
//
// forwardRef exposes the box's DOM node so the Trainer can measure it as the
// flight target for the card.
const LeitnerBox = forwardRef(function LeitnerBox({ label, caption, tone = 'good', pulse = 0 }, ref) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (pulse === 0) return undefined;
    setActive(true);
    const t = setTimeout(() => setActive(false), 640);
    return () => clearTimeout(t);
  }, [pulse]);

  return (
    <div
      ref={ref}
      className={`leitner-box leitner-box--${tone}${active ? ' leitner-box--receiving' : ''}`}
      aria-hidden="true"
    >
      <div className="leitner-box-glow" />
      <div className="leitner-box-back" />
      <div className="leitner-box-flap leitner-box-flap--l" />
      <div className="leitner-box-flap leitner-box-flap--r" />
      <div className="leitner-box-body">
        <span className="leitner-box-label">{label}</span>
      </div>
      {caption && <span className="leitner-box-caption">{caption}</span>}
    </div>
  );
});

export default LeitnerBox;
