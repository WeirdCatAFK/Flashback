/**
 * Terrain scan — a survey scanner's hologram of a mountain range: the land as a
 * wireframe mesh seen in perspective, the scanner on the near ground, and the places it
 * has flagged bracketed. The land has a spire, a long jagged ridge, a crater, a mesa and
 * a gentle swell, so each reads differently in the mesh.
 *
 * When covers move, the scanner pings: a ring of light spreads over the ground, each
 * strand of the mesh flares as the ring reaches it and dims back, and the flagged places
 * blink and hold. The mesh is cut into short segments sorted by their distance from the
 * scanner into bands, one path per band, so the sweep is a few dozen CSS animations with
 * staggered delays and no script (the scan-* classes in CoverArt.css, whose ping length
 * PING and SWEEP must match).
 *
 * The land is laid out on a unit square, `u` across and `v` from far (0) to near (1);
 * distances on it stretch `u` by ASPECT so shapes come out round on a wide banner.
 */

import { W, range, HAIR } from './artKit.js';

const pt = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;

const ASPECT = 2.2;
const SCANNER = [0.5, 0.86];

/** Seconds from one ping to the next, and the share of it the ring takes to cross the land. */
const PING = 8;
const SWEEP = 0.7;
const BANDS = 36;

const groundDistance = (u, v, cu, cv) => Math.hypot((u - cu) * ASPECT, v - cv);

/** How high the land stands at (u, v), about 0 to 1. */
function height(u, v) {
  const spire = 0.95 * Math.exp(-((groundDistance(u, v, 0.2, 0.45) / 0.13) ** 2));
  const [ax, ay, bx, by] = [0.45, 0.22, 0.82, 0.4];
  const t = Math.min(1, Math.max(0, ((u - ax) * (bx - ax) * ASPECT ** 2 + (v - ay) * (by - ay)) / ((bx - ax) ** 2 * ASPECT ** 2 + (by - ay) ** 2)));
  const ridge = 0.55 * Math.exp(-((groundDistance(u, v, ax + t * (bx - ax), ay + t * (by - ay)) / 0.1) ** 2)) * (0.9 + 0.1 * Math.sin(u * 12));
  const fromCrater = groundDistance(u, v, 0.7, 0.68);
  const crater = 0.45 * Math.exp(-(((fromCrater - 0.13) / 0.06) ** 2)) - 0.1 * Math.exp(-((fromCrater / 0.08) ** 2));
  const mesa = 0.3 / (1 + Math.exp((groundDistance(u, v, 0.36, 0.72) - 0.1) / 0.02));
  const swell = 0.05 * Math.sin(u * 7 + v * 3) + 0.03 * Math.sin(u * 17 - v * 9);
  return spire + ridge + crater + mesa + swell;
}

/** Nearer ground spreads wider; every row is wider than the banner, so the mesh has no edge. */
const spread = (v) => 1.05 + 0.45 * v;
const groundY = (v) => 40 + v * 85;

function project(u, v, lift = height(u, v)) {
  const s = spread(v);
  return [W / 2 + (u - 0.5) * W * s, groundY(v) - lift * 38 * s];
}

const FAR = Math.max(...[[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => groundDistance(u, v, ...SCANNER)));

/** The mesh as short segments, each filed into a band by how far its middle is from the scanner. */
function meshBands() {
  const bands = range(BANDS).map(() => []);
  const add = (u0, v0, u1, v1) => {
    const d = groundDistance((u0 + u1) / 2, (v0 + v1) / 2, ...SCANNER);
    bands[Math.min(BANDS - 1, Math.floor((d / FAR) * BANDS))].push(`M${pt(...project(u0, v0))}L${pt(...project(u1, v1))}`);
  };
  const rows = 22;
  const cols = 44;
  const along = 120;
  const down = 36;
  range(rows).forEach((r) => range(along - 1).forEach((i) => add(i / (along - 1), r / (rows - 1), (i + 1) / (along - 1), r / (rows - 1))));
  range(cols).forEach((c) => range(down - 1).forEach((j) => add(c / (cols - 1), j / (down - 1), c / (cols - 1), (j + 1) / (down - 1))));
  return bands.map((b) => b.join(''));
}

/** When the ring reaches something `d` from the scanner, as a (negative) delay into the ping. */
const reachedAt = (d) => `${(((d / FAR) * SWEEP - 1) * PING).toFixed(2)}s`;

const BAND_PATHS = meshBands();
const [SX, SY] = [W / 2 + (SCANNER[0] - 0.5) * W * spread(SCANNER[1]), groundY(SCANNER[1])];

/** The places the scanner has flagged: the spire's summit, the ridge, the crater's rim, the mesa. */
const FLAGS = [[0.2, 0.45], [0.63, 0.31], [0.7, 0.55], [0.36, 0.72]].map(([u, v]) => {
  const [x, y] = project(u, v);
  return { x, y, ground: groundY(v), delay: reachedAt(groundDistance(u, v, ...SCANNER)) };
});

const bracket = (x, y) => `M${x - 9} ${y - 5}V${y - 9}H${x - 5}M${x + 5} ${y - 9}H${x + 9}V${y - 5}M${x + 9} ${y + 5}V${y + 9}H${x + 5}M${x - 5} ${y + 9}H${x - 9}V${y + 5}`;

export const terrainScan = (
  <g>
    <ellipse
      className="is-light scan-pulse"
      style={{ transformOrigin: `${SX.toFixed(1)}px ${SY.toFixed(1)}px` }}
      cx={SX}
      cy={SY}
      rx={(FAR / ASPECT) * W * spread(SCANNER[1])}
      ry={FAR * 85}
      fillOpacity="0.1"
      opacity="0.5"
    />
    <g className="cover-art__line">
      <ellipse className="scan-pulse" style={{ transformOrigin: `${SX.toFixed(1)}px ${SY.toFixed(1)}px` }} cx={SX} cy={SY} rx={(FAR / ASPECT) * W * spread(SCANNER[1])} ry={FAR * 85} strokeWidth="2" opacity="0.5" {...HAIR} />
      {BAND_PATHS.map((d, b) => (
        <path key={b} className="scan-band" style={{ animationDelay: reachedAt(((b + 0.5) / BANDS) * FAR) }} d={d} strokeWidth="0.9" opacity="0.55" {...HAIR} />
      ))}
    </g>
    {FLAGS.map((f) => (
      <g key={f.x} className="scan-blip" style={{ animationDelay: f.delay }}>
        <g className="cover-art__line">
          <line x1={f.x} x2={f.x} y1={f.y + 10} y2={f.ground} strokeWidth="1" strokeDasharray="2 3" {...HAIR} />
          <path d={bracket(f.x, f.y)} strokeWidth="1.5" {...HAIR} />
        </g>
        <path className="is-full" d={`M${pt(f.x, f.y - 4)}L${pt(f.x + 4, f.y)}L${pt(f.x, f.y + 4)}L${pt(f.x - 4, f.y)}Z`} />
      </g>
    ))}
    <path className="is-full" d={`M${pt(SX, SY - 11)}L${pt(SX + 6, SY)}L${pt(SX, SY + 3)}L${pt(SX - 6, SY)}Z`} />
    <g className="cover-art__line">
      <ellipse cx={SX} cy={SY} rx="16" ry="5" strokeWidth="1.25" {...HAIR} />
    </g>
  </g>
);
