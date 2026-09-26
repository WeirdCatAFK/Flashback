/**
 * The life-and-earth covers: a naturalist's plate, the tree of life, a sunflower's
 * seeds, an old atlas's hemispheres, a scanner's hologram of mountains (terrainScan.jsx)
 * and the northern lights. See CoverArt for how a
 * drawing is made and painted.
 */

import { W, hash, range, HAIR } from './artKit.js';
import { terrainScan } from './terrainScan.jsx';

const pt = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;

/** A pointed leaf from `base` along `dir` (a unit vector), as a closed path. */
function leafPath([bx, by], [dx, dy], length, width) {
  const [nx, ny] = [-dy, dx];
  const at = (u, side) => pt(bx + dx * length * u + nx * width * side, by + dy * length * u + ny * width * side);
  return `M${pt(bx, by)}C${at(0.25, 1)} ${at(0.7, 0.8)} ${at(1, 0)}C${at(0.7, -0.8)} ${at(0.25, -1)} ${pt(bx, by)}Z`;
}

const unit = (a) => [Math.cos(a), Math.sin(a)];

/**
 * A fern frond: its stem a curve from base to tip, with a leaflet either side at every
 * step, leaning toward the tip and shrinking as they near it.
 */
function frond({ base, ctrl, tip, pinnae, length }) {
  const at = (t) => [0, 1].map((i) => (1 - t) ** 2 * base[i] + 2 * (1 - t) * t * ctrl[i] + t * t * tip[i]);
  const tangent = (t) => {
    const [dx, dy] = [0, 1].map((i) => 2 * (1 - t) * (ctrl[i] - base[i]) + 2 * t * (tip[i] - ctrl[i]));
    return Math.atan2(dy, dx);
  };
  const leaves = range(pinnae).flatMap((i) => {
    const t = 0.06 + (0.9 * i) / pinnae;
    const size = length * (1 - t) ** 0.7 + 4;
    return [-1, 1].map((side) => leafPath(at(t), unit(tangent(t) + side * 1.0), size, size * 0.22));
  });
  return { stem: `M${pt(...base)}Q${pt(...ctrl)} ${pt(...tip)}`, leaves: leaves.join('') };
}

const FRONDS = [
  { base: [-10, 170], ctrl: [110, 10], tip: [300, 38], pinnae: 24, length: 38, tone: 'is-mid' },
  { base: [150, 175], ctrl: [250, 55], tip: [420, 92], pinnae: 20, length: 30, tone: 'is-full' },
].map((f) => ({ ...f, ...frond(f) }));

/** A broad leaf with its midrib and side veins cut back out in the ground colour. */
function broadLeaf(base, angle, length, width) {
  const [dx, dy] = unit(angle);
  const [nx, ny] = [-dy, dx];
  const veins = range(7).flatMap((i) => {
    const u = 0.15 + i * 0.11;
    const [mx, my] = [base[0] + dx * length * u, base[1] + dy * length * u];
    return [-1, 1].map((side) => `M${pt(mx, my)}L${pt(mx + dx * length * 0.13 + nx * width * 0.7 * side, my + dy * length * 0.13 + ny * width * 0.7 * side)}`);
  });
  return {
    base,
    blade: leafPath(base, [dx, dy], length, width),
    stalk: `M${pt(base[0] - dx * 16, base[1] - dy * 16)}L${pt(...base)}`,
    veins: `M${pt(...base)}L${pt(base[0] + dx * length * 0.94, base[1] + dy * length * 0.94)}${veins.join('')}`,
  };
}

const LEAVES = [
  { ...broadLeaf([505, 118], -0.66, 150, 46), tone: 'is-light' },
  { ...broadLeaf([560, 160], -1.4, 95, 30), tone: 'is-mid' },
];

const botanical = (
  <g>
    {FRONDS.map((f, i) => (
      <g key={f.tip[0]} className="cover-sway" style={{ transformOrigin: `${f.base[0]}px ${f.base[1]}px`, animationDuration: `${7 + i * 2}s`, animationDelay: `-${i * 3}s` }}>
        <path className={f.tone} d={f.leaves} />
        <g className="cover-art__line"><path d={f.stem} strokeWidth="2" {...HAIR} /></g>
      </g>
    ))}
    {LEAVES.map((l, i) => (
      <g key={l.blade} className="cover-sway" style={{ transformOrigin: `${l.base[0]}px ${l.base[1]}px`, animationDuration: `${8 + i * 3}s`, animationDelay: `-${i * 4 + 1}s` }}>
        <g className="cover-art__line"><path d={l.stalk} strokeWidth="2.5" {...HAIR} /></g>
        <path className={`${l.tone} is-sheet`} d={l.blade} strokeWidth="1.5" {...HAIR} />
        <g className="cover-art__rule"><path d={l.veins} strokeWidth="1.25" {...HAIR} /></g>
      </g>
    ))}
  </g>
);

/**
 * The tree of life, in the manner of Darwin's notebook sketch: one root branching left
 * to right, each split at its own distance; most lineages reach the present at the right
 * edge, a few stop short, extinct, with a bar across.
 */
const TIPS = 24;
const tipY = (i) => 16 + (i * 118) / (TIPS - 1);

function clade(lo, hi, x, k, out) {
  if (hi - lo === 1) {
    const y = tipY(lo);
    const living = hash(k + 7) > 0.28;
    const end = living ? 592 : Math.min(592, x + 24 + hash(k + 9) * 70);
    out.lines.push(`M${pt(x, y)}H${end.toFixed(1)}`);
    out.tips.push({ x: end, y, living });
    return y;
  }
  const split = lo + 1 + Math.floor(hash(k) * (hi - lo - 1));
  const step = (560 - x) * (0.1 + hash(k + 3) * 0.22);
  const nx = x + step;
  const ya = clade(lo, split, nx, k * 2 + 1, out);
  const yb = clade(split, hi, nx, k * 2 + 2, out);
  const y = (ya + yb) / 2;
  for (const cy of [ya, yb]) out.lines.push(`M${pt(x, y)}C${pt(x + step / 2, y)} ${pt(x + step / 2, cy)} ${pt(nx, cy)}`);
  return y;
}

const PHYLOGENY = { lines: [], tips: [] };
PHYLOGENY.lines.push(`M0 ${clade(0, TIPS, 30, 1, PHYLOGENY).toFixed(1)}H30`);

const tree = (
  <g>
    <g className="cover-art__line">
      <path d={PHYLOGENY.lines.join('')} strokeWidth="1.5" {...HAIR} />
      <path d={PHYLOGENY.tips.filter((t) => !t.living).map((t) => `M${pt(t.x, t.y - 4)}V${(t.y + 4).toFixed(1)}`).join('')} strokeWidth="1.5" {...HAIR} />
    </g>
    <g className="cover-art__fill">
      {PHYLOGENY.tips.filter((t) => t.living).map((t) => <circle key={t.y} cx={t.x} cy={t.y} r="2.6" />)}
    </g>
  </g>
);

/**
 * A sunflower: seeds on the golden-angle spiral (phyllotaxis), cut out of a dark disc,
 * in two rings of petals; two more flowers lean in from the corners.
 */
function sunflower(cx, cy, scale, seeds) {
  const disc = scale * 2.55 * Math.sqrt(seeds) + 2 * scale;
  const petals = (count, offset, length) => range(count).map((j) => {
    const a = (j * 2 * Math.PI) / count + offset;
    const [dx, dy] = unit(a);
    return leafPath([cx + dx * (disc - 4), cy + dy * (disc - 4)], [dx, dy], length * scale * (0.9 + hash(j) * 0.2), 9 * scale);
  }).join('');
  return {
    cx,
    cy,
    disc,
    back: petals(34, 0.09, 40),
    front: petals(34, 0, 32),
    seeds: range(seeds).map((i) => {
      const r = scale * 2.55 * Math.sqrt(i + 1);
      const a = (i + 1) * 2.39996;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), r: scale * (0.7 + (0.9 * r) / (disc || 1)) };
    }),
  };
}

const FLOWERS = [sunflower(310, 75, 1, 700), sunflower(40, 132, 0.55, 260), sunflower(588, 22, 0.6, 300)];

const flowers = (
  <g>
    {FLOWERS.map((f, i) => (
      <g key={f.cx} className="cover-turn" style={{ transformOrigin: `${f.cx}px ${f.cy}px`, animationDuration: `${i ? 180 : 240}s` }}>
        <path className="is-light" d={f.back} />
        <path className="is-mid" d={f.front} />
        <circle className="is-full" cx={f.cx} cy={f.cy} r={f.disc} />
        <g className="cover-art__ground">
          {f.seeds.map((s) => <circle key={`${s.x}-${s.y}`} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} />)}
        </g>
      </g>
    ))}
  </g>
);

/**
 * A graticule as an old atlas draws the world: two hemispheres side by side, their
 * meridians and parallels drawn in, over a portolan's rhumb lines fanning out from two
 * compass roses.
 */
const HEMISPHERES = [238, 382];
const GLOBE_R = 70;

/**
 * Meridians every 15° round half the globe; each ellipse is a meridian and the one
 * opposite it. Its width is the cosine of its longitude, so turning the globe is each
 * ellipse narrowing through a line and widening out the other way (`globe-meridian` in
 * CoverArt.css), half a turn every GLOBE_TURN seconds.
 */
const MERIDIANS = range(12).map((i) => i * 15);
const GLOBE_TURN = 20;
const ROSES = [62, 558];

function rosePath(cx, cy) {
  return `M${range(16).map((i) => {
    const a = (i * Math.PI) / 8 - Math.PI / 2;
    const r = i % 4 === 0 ? 24 : i % 2 === 0 ? 13 : 4;
    return pt(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }).join('L')}Z`;
}

const graticule = (
  <g>
    <g className="cover-art__line">
      {ROSES.flatMap((x) => range(32).map((i) => {
        const [dx, dy] = unit((i * Math.PI) / 16);
        return <line key={`${x}-${i}`} x1={x} y1="75" x2={x + dx * 700} y2={75 + dy * 700} strokeWidth="0.75" opacity="0.25" {...HAIR} />;
      }))}
    </g>
    {HEMISPHERES.map((cx) => (
      <g key={cx}>
        <circle className="is-ground" cx={cx} cy="75" r={GLOBE_R} />
        <g className="cover-art__line">
          <g transform={`translate(${cx} 75)`}>
            {MERIDIANS.map((deg) => (
              <ellipse
                key={deg}
                className="globe-meridian"
                style={{ '--s': Math.cos((deg * Math.PI) / 180).toFixed(4), animationDelay: `-${((deg / 180) * GLOBE_TURN).toFixed(2)}s` }}
                rx={GLOBE_R}
                ry={GLOBE_R}
                strokeWidth="1"
                opacity="0.6"
                {...HAIR}
              />
            ))}
          </g>
          {[-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75].map((deg) => {
            const a = (deg * Math.PI) / 180;
            const half = GLOBE_R * Math.cos(a);
            const y = 75 + GLOBE_R * Math.sin(a);
            return <line key={deg} x1={cx - half} x2={cx + half} y1={y} y2={y} strokeWidth={deg === 0 ? 1.75 : 1} opacity={deg === 0 ? 1 : 0.6} {...HAIR} />;
          })}
          <circle cx={cx} cy="75" r={GLOBE_R} strokeWidth="2.5" {...HAIR} />
          <circle cx={cx} cy="75" r={GLOBE_R + 5} strokeWidth="1" {...HAIR} />
        </g>
      </g>
    ))}
    {ROSES.map((x) => (
      <g key={x}>
        <path className="is-full" d={rosePath(x, 75)} />
        <g className="cover-art__line"><circle cx={x} cy="75" r="9" strokeWidth="1.25" {...HAIR} /></g>
      </g>
    ))}
  </g>
);

/**
 * Aurora borealis: two curtains of light rising from a wavering hem and fading upward
 * (each fine ray stacked in six steps of strength, the rays overlapping so they blur
 * into sheets), stars above, and a ridge of pines below.
 */
const FADE = [0.5, 0.38, 0.27, 0.18, 0.1, 0.05];

function curtain(base, amp, height, phase, k) {
  const steps = FADE.map(() => []);
  for (let x = -12; x <= W + 12; x += 3) {
    const hem = base + amp * Math.sin(x / 70 + phase) + amp * 0.4 * Math.sin(x / 23 + phase * 2);
    const h = height * (0.6 + 0.4 * Math.sin(x / 45 + phase)) + hash(k * 1000 + x) * 16;
    const step = h / FADE.length;
    FADE.forEach((_, i) => steps[i].push(`M${pt(x, hem - (i + 1) * step)}h3.4v${step.toFixed(1)}h-3.4Z`));
  }
  return steps.map((s) => s.join(''));
}

const CURTAINS = [{ strength: 0.6, steps: curtain(70, 10, 40, 2, 2) }, { strength: 1, steps: curtain(88, 12, 58, 0, 1) }];
const SKY = range(45).map((i) => ({ x: hash(i + 800) * W, y: 4 + hash(i + 900) * 56, r: 0.6 + hash(i + 1000) }));

const ridgeY = (x) => 112 + 10 * Math.sin(x / 57) + 6 * Math.sin(x / 19 + 1) + 1.5 * Math.sin(x / 7);

function ridge() {
  return `M0 150L${range(63).map((i) => pt(i * 10, ridgeY(i * 10))).join('L')}L${W} 150Z`;
}

function pines() {
  return range(70).filter((i) => hash(i + 1200) > 0.35).map((i) => {
    const x = i * 9 + hash(i + 1300) * 4;
    const y = ridgeY(x) + 3;
    const h = 6 + hash(i + 1400) * 7;
    return `M${pt(x - 2.6, y)}L${pt(x, y - h)}L${pt(x + 2.6, y)}Z`;
  }).join('');
}

const aurora = (
  <g className="cover-art__fill">
    {SKY.map((s) => <circle key={s.x} cx={s.x} cy={s.y} r={s.r} opacity="0.7" />)}
    {CURTAINS.map((c, n) => (
      <g key={n} className="cover-drift" style={{ animationDuration: `${11 + n * 4}s`, animationDelay: `-${n * 5}s` }}>
        {c.steps.map((d, i) => <path key={i} d={d} opacity={c.strength * FADE[i]} />)}
      </g>
    ))}
    <path d={ridge()} />
    <path d={pines()} />
  </g>
);

/** The life-and-earth covers, by id. */
export const NATURE_ART = { botanical, tree, sunflower: flowers, graticule, scan: terrainScan, aurora };
