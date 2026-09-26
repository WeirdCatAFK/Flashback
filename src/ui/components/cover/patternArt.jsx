/**
 * The pattern covers: paper, maps and plain repeats. See CoverArt for how a drawing is
 * made and painted.
 */

import { W, H, hash, range, HAIR } from './artKit.js';

/**
 * Rings: wide arcs rising from the lower right, darker as they widen. When covers move,
 * each ring grows into the next one's place and restarts; the outermost, with no ring to
 * become, fades away as it goes instead of vanishing when the loop restarts.
 */
const RINGS = 10;

const arcs = (
  <g className="cover-art__line">
    {range(RINGS).map((i) => {
      const r = 14 + i * 26;
      const o = 0.11 + i * 0.07;
      const last = i === RINGS - 1;
      return (
        <circle key={i} className="ring-fade" style={{ '--r0': `${r}px`, '--r1': `${r + 26}px`, '--o0': o, '--o1': last ? 0 : o + 0.07 }} cx="540" cy="170" r={r} strokeWidth="10" opacity={o} />
      );
    })}
  </g>
);

/** Ruled paper: notebook lines, a double margin and the binder holes. */
const ruled = (
  <g className="cover-art__line">
    {range(8).map((i) => (
      <line key={i} x1="0" x2={W} y1={12 + i * 18} y2={12 + i * 18} strokeWidth="1.25" opacity="0.6" {...HAIR} />
    ))}
    <line x1="128" x2="128" y1="0" y2={H} strokeWidth="1.5" {...HAIR} />
    <line x1="134" x2="134" y1="0" y2={H} strokeWidth="1.5" {...HAIR} />
    {[39, 75, 111].map((y) => <circle key={y} cx="44" cy={y} r="6" strokeWidth="1.5" {...HAIR} />)}
  </g>
);

/**
 * Graph paper, with a forgetting curve plotted on it: recall falls away after each
 * review and each review lifts it back, a little slower to fall every time.
 */
const REVIEWS = [[40, 34], [150, 70], [290, 130], [470, 260]];
const RECALLED = 50;

function forgettingCurve() {
  const parts = [];
  REVIEWS.forEach(([from, tau], i) => {
    const to = REVIEWS[i + 1]?.[0] ?? W;
    for (let x = from; x <= to; x += 5) {
      const y = RECALLED + 56 * (1 - Math.exp(-(x - from) / tau));
      parts.push(`${parts.length ? 'L' : 'M'}${x} ${y.toFixed(1)}`);
    }
  });
  return parts.join('');
}

const graph = (
  <g className="cover-art__line">
    {range(42).map((i) => (
      <line key={`v${i}`} x1={i * 15} x2={i * 15} y1="0" y2={H} strokeWidth="1" opacity={i % 5 ? 0.25 : 0.6} {...HAIR} />
    ))}
    {range(11).map((i) => (
      <line key={`h${i}`} x1="0" x2={W} y1={i * 15} y2={i * 15} strokeWidth="1" opacity={i % 5 ? 0.25 : 0.6} {...HAIR} />
    ))}
    <path className="cover-art__pen" d={forgettingCurve()} pathLength="1" strokeWidth="2.5" strokeLinejoin="round" {...HAIR} />
    {REVIEWS.map(([x]) => <circle key={x} className="is-full" cx={x} cy={RECALLED} r="4" />)}
  </g>
);

/** One closed contour line: a wobbly ellipse whose wobble grows no faster than it does, so rings never cross. */
function contour(cx, cy, r, phase) {
  const pts = range(72).map((i) => {
    const a = (i / 72) * Math.PI * 2;
    const rr = r * (1 + 0.14 * Math.sin(3 * a + phase)) + Math.min(5, r * 0.18) * Math.sin(5 * a + phase * 2);
    return `${(cx + rr * 1.45 * Math.cos(a)).toFixed(1)} ${(cy + rr * Math.sin(a)).toFixed(1)}`;
  });
  return `M${pts.join('L')}Z`;
}

/** Contours: a topographic map of two peaks. */
const contours = (
  <g>
    <g className="cover-art__line">
      {[[150, 92, 7, 0.4], [480, 58, 6, 2.1]].flatMap(([cx, cy, n, phase]) => range(n).map((k) => (
        <path key={`${cx}-${k}`} d={contour(cx, cy, 10 + k * 13, phase)} strokeWidth="1.25" opacity={0.9 - k * 0.07} {...HAIR} />
      )))}
    </g>
    <g className="cover-art__fill">
      <circle cx="150" cy="92" r="2.5" />
      <circle cx="480" cy="58" r="2.5" />
    </g>
  </g>
);

/** Halftone: a hex grid of dots growing from a speck on the left to full on the right. */
const DOTS = range(10).flatMap((row) => range(40).map((col) => {
  const x = col * 16 + (row % 2) * 8;
  const y = row * 16 + 3;
  const t = Math.min(1, Math.max(0, x / W + 0.1 * Math.sin(y / 22)));
  return { x, y, r: 0.5 + 6 * t ** 1.6 };
}));

const halftone = (
  <g className="cover-art__fill" opacity="0.8">
    {DOTS.map(({ x, y, r }) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r.toFixed(2)} />)}
  </g>
);

/** Mosaic: square tiles of every strength, a few missing. */
const TILES = range(100)
  .map((k) => ({ k, x: (k % 20) * 31 + 1.5, y: Math.floor(k / 20) * 31 - 2 }))
  .filter(({ k }) => hash(k + 11) > 0.12);

const mosaic = (
  <g className="cover-art__fill">
    {TILES.map(({ k, x, y }) => (
      <rect
        key={k}
        className={hash(k + 17) > 0.7 ? 'cover-shimmer' : undefined}
        style={{ animationDelay: `-${(hash(k + 19) * 5).toFixed(1)}s`, animationDuration: `${(4 + hash(k + 23) * 4).toFixed(1)}s` }}
        x={x}
        y={y}
        width="28"
        height="28"
        rx="2"
        opacity={(0.15 + 0.8 * hash(k) ** 1.4).toFixed(2)}
      />
    ))}
  </g>
);

/** Stripes: diagonal bands, each followed by a pinstripe. */
const stripes = (
  <g className="cover-art__fill" transform={`rotate(-32 ${W / 2} ${H / 2})`}>
    <g className="cover-slide" style={{ '--slide': '44px', animationDuration: '8s' }}>
      {range(19).flatMap((i) => {
        const x = -84 + i * 44;
        return [
          <rect key={`w${i}`} x={x} y="-170" width="20" height="490" opacity="0.7" />,
          <rect key={`p${i}`} x={x + 28} y="-170" width="5" height="490" opacity="0.45" />,
        ];
      })}
    </g>
  </g>
);

/** The pattern covers, by id. */
export const PATTERN_ART = { arcs, ruled, graph, contours, halftone, mosaic, stripes };
