/**
 * The study-desk covers: the things on a learner's desk, drawn. See CoverArt for how a
 * drawing is made and painted.
 */

import { W, hash, range, TONES, HAIR } from './artKit.js';

/** Scattered cards: two loose rows of cards, each at its own small angle. */
const cards = (
  <g className="cover-art__fill">
    {range(18).map((k) => {
      const x = 20 + (k % 9) * 66;
      const y = 18 + Math.floor(k / 9) * 64;
      const r = ((k * 37) % 9) - 4;
      return (
        <g key={k} className="cover-float" style={{ animationDelay: `-${(hash(k + 70) * 6).toFixed(1)}s`, animationDuration: `${(5 + hash(k + 90) * 3).toFixed(1)}s` }}>
          <rect x={x} y={y} width="48" height="30" rx="3" transform={`rotate(${r} ${x + 24} ${y + 15})`} opacity={0.35 + ((k * 13) % 5) / 10} />
        </g>
      );
    })}
  </g>
);

/** A pile of notes: far more sheets than fit, dropped on top of each other; some are written on. */
const NOTES = range(64).map((k) => ({
  x: -24 + hash(k) * 624,
  y: -24 + hash(k + 500) * 150,
  s: 40 + hash(k + 900) * 18,
  r: (hash(k + 1300) - 0.5) * 32,
  tone: TONES[k % 3],
  written: hash(k + 1700) > 0.5,
}));

const notes = (
  <g>
    {NOTES.map((n, k) => (
      <g key={k} transform={`rotate(${n.r.toFixed(1)} ${(n.x + n.s / 2).toFixed(1)} ${(n.y + n.s / 2).toFixed(1)})`}>
        <rect className={`${n.tone} is-sheet`} x={n.x} y={n.y} width={n.s} height={n.s} rx="2" strokeWidth="1.5" {...HAIR} />
        {n.written && (
          <g className="cover-art__rule">
            {[0.32, 0.5, 0.68].map((f, i) => (
              <line key={f} x1={n.x + 7} x2={n.x + n.s - (i === 2 ? n.s / 2 : 7)} y1={n.y + n.s * f} y2={n.y + n.s * f} strokeWidth="1.25" {...HAIR} />
            ))}
          </g>
        )}
      </g>
    ))}
  </g>
);

/** Card stack: index cards piled in stacks of different heights, seen edge-on. */
const stack = (
  <g>
    {[8, 12, 6, 10, 13].flatMap((n, s) => range(n).map((i) => {
      const k = s * 40 + i;
      const x = 22 + s * 120 + (hash(k) - 0.5) * 12;
      const y = 130 - i * 7;
      const r = (hash(k + 300) - 0.5) * 4;
      return <rect key={k} className={i % 2 ? 'is-mid' : 'is-full'} x={x} y={y} width="96" height="6" rx="1" transform={`rotate(${r.toFixed(2)} ${x + 48} ${y + 3})`} />;
    }))}
  </g>
);

/** Leitner boxes: five card boxes, each holding more cards than the one before. */
const leitner = (
  <g>
    {[2, 4, 7, 10, 14].map((n, b) => {
      const x = 22 + b * 120;
      return (
        <g key={b}>
          {range(n).map((i) => {
            const k = b * 50 + i;
            return <rect key={i} className="is-light is-sheet" x={x + 8 + (hash(k) - 0.5) * 8} y={40 + hash(k + 700) * 16} width="80" height="50" rx="2" strokeWidth="1.25" {...HAIR} />;
          })}
          <rect className="is-full" x={x} y="80" width="96" height="54" rx="3" />
          <rect className="is-ground" x={x + 33} y="92" width="30" height="12" rx="2" />
        </g>
      );
    })}
  </g>
);

/** Bookshelf: spines of every width and height on one shelf, some with bands. */
const SHELF = 106;
const SPINES = [];
for (let x = 8, k = 0; ; k++) {
  const w = 10 + Math.round(hash(k) * 16);
  if (x + w > W - 8) break;
  SPINES.push({ x, w, h: 44 + Math.round(hash(k + 100) * 36), tone: TONES[Math.floor(hash(k + 200) * 3)], banded: hash(k + 300) > 0.4 });
  x += w + 2 + (hash(k + 400) > 0.9 ? 16 : 0);
}

const shelf = (
  <g>
    {SPINES.map(({ x, w, h, tone, banded }) => (
      <g key={x}>
        <rect className={tone} x={x} y={SHELF - h} width={w} height={h} rx="1.5" />
        {banded && (
          <>
            <rect className="is-ground" x={x + 2} y={SHELF - h + 8} width={w - 4} height="2.5" />
            <rect className="is-ground" x={x + 2} y={SHELF - h + 13} width={w - 4} height="2.5" />
            <rect className="is-ground" x={x + 2} y={SHELF - 12} width={w - 4} height="2.5" />
          </>
        )}
      </g>
    ))}
    <rect className="is-full" x="0" y={SHELF} width={W} height="6" />
  </g>
);

/** Constellation: stars on a jittered grid, each joined to its nearest neighbours. */
const STARS = range(30).map((k) => ({
  x: (k % 10) * 62 + 10 + hash(k) * 42,
  y: Math.floor(k / 10) * 50 + 10 + hash(k + 60) * 30,
  r: 1.6 + hash(k + 120) ** 2 * 3.4,
}));

/** Each star's nearest neighbour, and its second nearest when that one is close, once per pair. */
function nearestLinks(points) {
  const seen = new Set();
  const links = [];
  points.forEach((p, i) => {
    const near = points
      .map((o, j) => ({ j, d: Math.hypot(o.x - p.x, o.y - p.y) }))
      .filter((o) => o.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    near.forEach(({ j, d }, n) => {
      const id = i < j ? `${i}-${j}` : `${j}-${i}`;
      if ((n === 0 || d < 70) && !seen.has(id)) {
        seen.add(id);
        links.push({ id, a: p, b: points[j] });
      }
    });
  });
  return links;
}

const stars = (
  <g>
    <g className="cover-art__line">
      {nearestLinks(STARS).map(({ id, a, b }) => (
        <line key={id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth="1" opacity="0.5" {...HAIR} />
      ))}
    </g>
    <g className="cover-art__fill">
      {STARS.filter((s) => s.r > 3.6).map((s) => <circle key={`h${s.x}`} cx={s.x} cy={s.y} r={s.r * 2.4} opacity="0.18" />)}
      {STARS.map((s, i) => (
        <circle key={s.x} className="cover-twinkle" style={{ animationDelay: `-${(hash(i + 150) * 5).toFixed(1)}s`, animationDuration: `${(3 + hash(i + 170) * 3).toFixed(1)}s` }} cx={s.x} cy={s.y} r={s.r} />
      ))}
    </g>
  </g>
);

/** The study-desk covers, by id. */
export const STUDY_ART = { cards, notes, stack, leitner, shelf, stars };
