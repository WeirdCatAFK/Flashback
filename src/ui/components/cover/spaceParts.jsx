import { hash, HAIR } from './artKit.js';
import { polyline } from './spaceKit.js';

export function box(b, key) {
  return (
    <g key={key}>
      <path className="is-light is-sheet" d={b.top} strokeWidth="0.75" {...HAIR} />
      <path className="is-mid is-sheet" d={b.left} strokeWidth="0.75" {...HAIR} />
      <path className="is-full is-sheet" d={b.right} strokeWidth="0.75" {...HAIR} />
    </g>
  );
}

export function cylinder(c, key) {
  return (
    <g key={key}>
      <path className="is-mid" d={c.side} />
      <path className="is-full" d={c.shade} opacity="0.6" />
      <ellipse className="is-light is-sheet" cx={c.cap.cx} cy={c.cap.cy} rx={c.cap.rx} ry={c.cap.ry} strokeWidth="0.75" {...HAIR} />
    </g>
  );
}

export function sky(stars) {
  return (
    <g className="cover-art__fill">
      {stars.map((s, i) => (
        <circle
          key={i}
          className={i % 5 === 0 ? 'cover-twinkle' : undefined}
          style={i % 5 === 0 ? { animationDelay: `-${(hash(i + 7) * 4).toFixed(1)}s` } : undefined}
          cx={s.x.toFixed(1)}
          cy={s.y.toFixed(1)}
          r={s.r.toFixed(2)}
          opacity={(0.4 + s.r * 0.3).toFixed(2)}
        />
      ))}
    </g>
  );
}

export function belt(points, key, pace = '1.2s') {
  const d = polyline(points);
  return (
    <g key={key} className="cover-art__line" strokeLinejoin="round">
      <path d={d} strokeWidth="5" opacity="0.4" {...HAIR} />
      <path className="belt-items" style={{ animationDuration: pace }} d={d} strokeWidth="3" strokeDasharray="3 6" {...HAIR} />
    </g>
  );
}
