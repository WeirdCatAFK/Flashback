/**
 * The space covers of things seen: a wheel station over the Earth, an asteroid field,
 * the Earth rising over the Moon, a ringed planet, a black hole and a space telescope
 * with its deep field. See CoverArt for how a drawing is made and painted; what moves is
 * on the classes CoverArt.css animates (cover-turn, cover-orbit, cover-upright,
 * cover-hover, cover-twinkle, flow-dash).
 *
 * Whatever a ring or a disk passes behind is drawn in halves (spaceKit's ellipseHalves):
 * the far half first, then the body, then the near half over it.
 */

import { W, hash, range, HAIR } from './artKit.js';
import { pt, poly, starfield, rock, ellipseHalves, isoProjector } from './spaceKit.js';
import { sky } from './spaceParts.jsx';

/**
 * A wheel station over the Earth: the ring (its windows sliding as it turns) on spokes
 * that turn about a hub, a mast carrying two solar wings, a docking module below, nav
 * lights at the wing tips, and a shuttle coming in. The wheel is a circle squashed into
 * an ellipse, so its spokes turn in the circle and are squashed with it.
 */
const WHEEL = 105;
const WHEEL_TILT = 0.2857;
const TORUS = ellipseHalves(WHEEL, WHEEL * WHEEL_TILT);

const station = (
  <g>
    {sky(starfield(4100, 70, 0, 100))}
    <circle className="is-light" cx="310" cy="640" r="540" />
    <g className="cover-art__line">
      <circle cx="310" cy="640" r="547" strokeWidth="4" opacity="0.3" {...HAIR} />
    </g>
    <g className="cover-art__rule" opacity="0.8">
      <circle cx="310" cy="640" r="530" strokeWidth="2" strokeDasharray="30 18 8 22" {...HAIR} />
      <circle cx="310" cy="640" r="518" strokeWidth="1.5" strokeDasharray="12 26 40 14" {...HAIR} />
    </g>
    <g transform="translate(310 66) rotate(-8) scale(0.72)">
      <path className="is-stroke-mid" d={TORUS.back} fill="none" strokeWidth="12" />
      <g className="cover-art__rule">
        <path className="flow-dash" style={{ animationDuration: '2.4s' }} d={TORUS.back} strokeWidth="2.5" strokeDasharray="2 8" {...HAIR} />
      </g>
      <g transform={`scale(1 ${WHEEL_TILT})`}>
        <g className="cover-turn" style={{ animationDuration: '40s' }}>
          <g className="cover-art__line">
            {range(6).map((i) => {
              const a = (i / 6) * Math.PI * 2;
              return <line key={i} x1="0" y1="0" x2={(WHEEL * Math.cos(a)).toFixed(1)} y2={(WHEEL * Math.sin(a)).toFixed(1)} strokeWidth="2.5" {...HAIR} />;
            })}
          </g>
        </g>
      </g>
      <g className="cover-art__line">
        <path d="M0 -26V-50M0 -50L-60 -50M0 -50L60 -50" strokeWidth="2" {...HAIR} />
      </g>
      {[-1, 1].map((side) => (
        <g key={side}>
          <rect className="is-mid is-sheet" x={side < 0 ? -126 : 16} y="-55" width="110" height="10" strokeWidth="0.75" {...HAIR} />
          <g className="cover-art__rule">
            <path d={`${range(10).map((i) => `M${side < 0 ? -116 + i * 10 : 26 + i * 10} -55V-45`).join('')}M${side < 0 ? -126 : 16} -50H${side < 0 ? -16 : 126}`} strokeWidth="0.75" {...HAIR} />
          </g>
          <circle className="is-full cover-twinkle" style={{ animationDuration: '1.8s', animationDelay: side < 0 ? '-0.9s' : '0s' }} cx={side * 128} cy="-50" r="2.2" />
        </g>
      ))}
      <rect className="is-mid is-sheet" x="-10" y="-26" width="20" height="48" strokeWidth="0.75" {...HAIR} />
      <ellipse className="is-light is-sheet" cx="0" cy="-26" rx="10" ry="3" strokeWidth="0.75" {...HAIR} />
      <rect className="is-full" x="-6" y="22" width="12" height="18" />
      <g className="cover-art__line"><ellipse cx="0" cy="40" rx="7" ry="2.2" strokeWidth="1.5" {...HAIR} /></g>
      <path className="is-stroke-full" d={TORUS.front} fill="none" strokeWidth="12" />
      <g className="cover-art__rule">
        <path className="flow-dash" style={{ animationDuration: '2.4s' }} d={TORUS.front} strokeWidth="2.5" strokeDasharray="2 8" {...HAIR} />
      </g>
    </g>
    <g className="cover-hover" style={{ '--hover': '3px', animationDuration: '6s' }}>
      <path className="is-full" d="M532 30L548 27L556 30L548 33Z" />
      <path className="is-mid" d="M540 28L536 22L542 28M540 32L536 38L542 32" />
    </g>
  </g>
);

/**
 * An asteroid field: rocks of every size, each shaded (a darker body with a lit face
 * and a few craters) and, when covers move, tumbling slowly about its own centre.
 */
const ROCKS = [
  [430, 78, 44], [150, 58, 30], [270, 118, 18], [560, 30, 16], [40, 110, 22], [330, 34, 10], [600, 118, 26],
  [210, 20, 8], [490, 140, 12], [95, 22, 9], [370, 92, 6], [240, 70, 5], [520, 96, 5],
].map(([x, y, r], i) => ({ x, y, r, seed: 4300 + i * 17 }));

const asteroids = (
  <g>
    {sky(starfield(4200, 90))}
    <g className="cover-art__fill" opacity="0.5">
      {range(40).map((i) => <circle key={i} cx={(hash(i + 4400) * W).toFixed(1)} cy={(hash(i + 4450) * 150).toFixed(1)} r={(0.6 + hash(i + 4480)).toFixed(2)} />)}
    </g>
    {ROCKS.map(({ x, y, r, seed }) => (
      <g
        key={seed}
        className="cover-turn"
        style={{ transformOrigin: `${x}px ${y}px`, animationDuration: `${(60 + hash(seed) * 140).toFixed(0)}s`, animationDirection: hash(seed + 1) > 0.5 ? 'reverse' : undefined }}
      >
        <path className="is-full" d={poly(rock(x, y, r, seed, 12))} />
        <path className="is-mid" d={poly(rock(x - r * 0.18, y - r * 0.18, r * 0.7, seed, 12))} />
        {r > 9 && range(3).map((k) => (
          <ellipse key={k} className="is-light" cx={x + (hash(seed + k * 5) - 0.6) * r * 0.9} cy={y + (hash(seed + k * 5 + 1) - 0.6) * r * 0.7} rx={r * (0.1 + hash(seed + k) * 0.08)} ry={r * 0.07} opacity="0.7" />
        ))}
      </g>
    ))}
  </g>
);

/**
 * Earthrise, after the photograph from Apollo 8: the Earth, lit on one side and lost in
 * the dark on the other, over the curve of the Moon's cratered horizon. When covers move
 * it rises and sinks a little behind the horizon.
 */
const EARTH = { cx: 230, cy: 62, r: 30 };
const HORIZON = { cy: 3090, r: 3000 };
const horizonY = (x) => HORIZON.cy - Math.sqrt(HORIZON.r ** 2 - (x - 310) ** 2);
const CRATERS = range(22).map((i) => {
  const depth = hash(i + 4600);
  const x = hash(i + 4650) * W;
  const rx = 5 + depth * 26;
  return { x, y: horizonY(x) + 6 + depth * 48, rx, ry: rx * (0.18 + depth * 0.1) };
});

const earthrise = (
  <g>
    {sky(starfield(4500, 25))}
    <g className="cover-hover" style={{ '--hover': '8px', animationDuration: '50s' }}>
      <g transform={`rotate(-35 ${EARTH.cx} ${EARTH.cy})`}>
        <circle className="is-light" cx={EARTH.cx} cy={EARTH.cy} r={EARTH.r} />
        {[[240, 48, 8, 4610], [246, 66, 6, 4620], [233, 72, 4, 4630]].map(([x, y, r, seed]) => <path key={seed} className="is-mid" d={poly(rock(x, y, r, seed))} />)}
        <g className="cover-art__rule" opacity="0.9">
          <path d={`M${EARTH.cx - 6} ${EARTH.cy - 18}q10 -4 20 2M${EARTH.cx + 2} ${EARTH.cy + 4}q8 -3 14 3M${EARTH.cx - 12} ${EARTH.cy + 14}q9 3 18 -1`} fill="none" strokeWidth="2" {...HAIR} />
        </g>
        <path className="is-ground" d={`M${EARTH.cx} ${EARTH.cy - EARTH.r - 1}A${EARTH.r + 1} ${EARTH.r + 1} 0 0 0 ${EARTH.cx} ${EARTH.cy + EARTH.r + 1}A${EARTH.r * 0.08} ${EARTH.r + 1} 0 0 1 ${EARTH.cx} ${EARTH.cy - EARTH.r - 1}Z`} />
      </g>
    </g>
    <path className="is-mid" d={`M0 150L${range(32).map((i) => pt(i * 20, horizonY(i * 20))).join('L')}L${W} 150Z`} />
    {CRATERS.map((c) => (
      <g key={c.x}>
        <ellipse className="is-full" cx={c.x} cy={c.y} rx={c.rx} ry={c.ry} opacity="0.8" />
        <g className="cover-art__rule">
          <path d={`M${pt(c.x - c.rx, c.y)}A${c.rx.toFixed(1)} ${c.ry.toFixed(1)} 0 0 0 ${pt(c.x + c.rx, c.y)}`} strokeWidth="1" opacity="0.7" {...HAIR} />
        </g>
      </g>
    ))}
  </g>
);

/**
 * A ringed planet: bands on its globe, a shadowed limb, rings passing behind it and in
 * front, a gap in them, and three moons on tilted orbits. When covers move, the moons go
 * round (squashed-circle orbits, as the orrery's).
 */
const RINGS = [[62, 3, 0.35], [70, 6, 0.55], [79, 4, 0.7], [88, 2, 0.4], [96, 7, 0.6], [106, 3, 0.35], [114, 1.5, 0.25]];
const RING_TILT = 0.22;
const GLOBE = 38;
const MOONS = [[150, 4, 40, 4710], [186, 3, 70, 4720], [236, 5.5, 110, 4730]];

const ringed = (
  <g>
    {sky(starfield(4700, 80))}
    <g transform="translate(330 76) rotate(-14)">
      <g className="cover-art__line">
        {MOONS.map(([rx]) => <ellipse key={rx} rx={rx} ry={rx * RING_TILT} strokeWidth="1" opacity="0.2" {...HAIR} />)}
        {RINGS.map(([rx, w, o]) => <path key={rx} d={ellipseHalves(rx, rx * RING_TILT).back} strokeWidth={w} opacity={o} {...HAIR} />)}
      </g>
      <circle className="is-light" r={GLOBE} />
      <g className="cover-art__line" opacity="0.45">
        {[-50, -30, -12, 8, 26, 44].map((lat, i) => {
          const a = (lat * Math.PI) / 180;
          const rx = GLOBE * Math.cos(a);
          return <path key={lat} d={ellipseHalves(rx, rx * RING_TILT).front} transform={`translate(0 ${(GLOBE * Math.sin(a)).toFixed(1)})`} strokeWidth={3 + (i % 3) * 1.5} {...HAIR} />;
        })}
      </g>
      <path className="is-mid" d={`M0 ${-GLOBE}A${GLOBE} ${GLOBE} 0 0 1 0 ${GLOBE}A${GLOBE * 0.55} ${GLOBE} 0 0 0 0 ${-GLOBE}Z`} opacity="0.5" />
      <g className="cover-art__line">
        {RINGS.map(([rx, w, o]) => <path key={rx} d={ellipseHalves(rx, rx * RING_TILT).front} strokeWidth={w} opacity={o} {...HAIR} />)}
      </g>
      <g transform={`scale(1 ${RING_TILT})`}>
        {MOONS.map(([rx, size, period, seed]) => (
          <g key={rx} className="cover-orbit" style={{ '--from': `${(hash(seed) * 360).toFixed(0)}deg`, animationDuration: `${period}s` }}>
            <g transform={`translate(${rx} 0)`}>
              <g className="cover-upright" style={{ animationDuration: `${period}s` }}>
                <circle className={seed % 2 ? 'is-full' : 'is-mid'} r={size} transform={`scale(1 ${(1 / RING_TILT).toFixed(4)})`} />
              </g>
            </g>
          </g>
        ))}
      </g>
    </g>
  </g>
);

/**
 * A black hole in the manner of the one in Interstellar, everything concentric with its
 * shadow and the whole disk on one ellipse (one tilt, TILT). The shadow sits inside a
 * crisp photon ring and a fainter second one. The far side of the accretion disk, bent
 * over and under the hole by its gravity, glows as a bright arc hugging the shadow's top
 * — fading out through three layers — and a thinner one under it. The disk itself is a
 * glowing ring with a white-hot inner edge that rings the shadow: its far half passes
 * behind the hole and its near half in front. Each ring of it brightens smoothly toward
 * the left, the side turning toward the viewer (Doppler beaming), a soft corona of light
 * surrounds the whole, and stars behind the hole are smeared by it into short arcs. It
 * is the one cover painted on its own deep sky (the is-deep, is-void, is-hot and is-glow
 * paints), so the void is dark and the light is light in every theme. When covers move
 * the disk swirls, its inner rings fastest, the lensed stars wheel slowly round, and the
 * glow breathes.
 */
const SHADOW = 30;
const TILT = 0.085;
const DISK = range(10).map((k) => {
  const rx = 44 + k * 14 + k * k * 0.5;
  return { rx, ry: rx * TILT, opacity: 0.95 - k * 0.075, width: 2.8 - k * 0.2, pace: `${(0.9 + k * 0.65).toFixed(1)}s` };
});

/** How bright the disk is at angle `t` round it: most on the left (t = π), turning toward the viewer. */
const beaming = (t) => 0.62 - 0.38 * Math.cos(t);

/** Twelve arcs of the ring from angle a to b (0 is the right, π/2 the near side), for a brightness that changes smoothly round it. */
function arcs(rx, ry, a, b, steps = 12) {
  return range(steps).map((i) => {
    const [t0, t1] = [a + ((b - a) * i) / steps, a + ((b - a) * (i + 1)) / steps];
    return {
      d: `M${pt(rx * Math.cos(t0), ry * Math.sin(t0))}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 0 1 ${pt(rx * Math.cos(t1), ry * Math.sin(t1))}`,
      beam: beaming((t0 + t1) / 2),
    };
  });
}

/** The disk's far half (angles π to 2π) or near half (0 to π): its glow in shaded arcs, its swirl as one dash along the half. */
const diskSide = (side) => {
  const [a, b] = side === 'back' ? [Math.PI, 2 * Math.PI] : [0, Math.PI];
  return DISK.map((ring) => (
    <g key={ring.rx}>
      {arcs(ring.rx, ring.ry, a, b).map((arc) => (
        <path key={arc.d} d={arc.d} strokeWidth={ring.width} opacity={(ring.opacity * 0.6 * arc.beam).toFixed(2)} {...HAIR} />
      ))}
      <path
        className="flow-dash"
        style={{ animationDuration: ring.pace }}
        d={`M${pt(ring.rx * Math.cos(a), ring.ry * Math.sin(a))}A${ring.rx.toFixed(1)} ${ring.ry.toFixed(1)} 0 0 1 ${pt(ring.rx * Math.cos(b), ring.ry * Math.sin(b))}`}
        strokeWidth={ring.width}
        strokeDasharray="5 15"
        opacity={(ring.opacity * 0.75).toFixed(2)}
        {...HAIR}
      />
    </g>
  ));
};

/** The part of the ring between radii `inner` and `outer`, over the top (`over`) or under the bottom. */
function arcBand(inner, outer, over) {
  const sweep = over ? 1 : 0;
  const back = over ? 0 : 1;
  return `M${-outer} 0A${outer} ${outer} 0 0 ${sweep} ${outer} 0H${inner}A${inner} ${inner} 0 0 ${back} ${-inner} 0Z`;
}

/** Half of the disk's glowing band: the ring between two ellipses of the one tilt, far half or near half. */
function diskBand(inner, outer, half) {
  const [R, Ry, r, ry] = [outer, outer * TILT, inner, inner * TILT];
  return half === 'back'
    ? `M${-R} 0A${R} ${Ry.toFixed(2)} 0 0 1 ${R} 0H${r}A${r} ${ry.toFixed(2)} 0 0 0 ${-r} 0Z`
    : `M${R} 0A${R} ${Ry.toFixed(2)} 0 0 1 ${-R} 0H${-r}A${r} ${ry.toFixed(2)} 0 0 0 ${r} 0Z`;
}

const band = (half) => (
  <g key={half}>
    <path className="is-glow" d={diskBand(40, 156, half)} opacity="0.55" />
    <path className="is-glow" d={diskBand(40, 104, half)} opacity="0.6" />
    <g className="cover-art__hot">
      <path d={ellipseHalves(42, 42 * TILT)[half]} strokeWidth="2.2" opacity="0.95" {...HAIR} />
      <path d={ellipseHalves(70, 70 * TILT)[half]} strokeWidth="1" opacity="0.6" {...HAIR} />
    </g>
  </g>
);

/** Background stars caught near the hole, each drawn out along a circle round it. */
const LENSED = range(12).map((i) => {
  const r = 58 + hash(i + 5600) * 60;
  const a = hash(i + 5650) * Math.PI * 2;
  const sweep = 0.12 + hash(i + 5700) * 0.3;
  const [a0, a1] = [a - sweep / 2, a + sweep / 2];
  return {
    d: `M${pt(r * Math.cos(a0), r * Math.sin(a0) * 0.9)}A${r.toFixed(1)} ${(r * 0.9).toFixed(1)} 0 0 1 ${pt(r * Math.cos(a1), r * Math.sin(a1) * 0.9)}`,
    width: 0.8 + hash(i + 5750) * 1.2,
  };
});

const blackhole = (
  <g>
    <rect className="is-deep" x="-20" y="-20" width={W + 40} height="190" />
    {starfield(4900, 110).filter((s) => Math.hypot(s.x - 310, (s.y - 75) * 2.5) > 130).map((s, i) => (
      <circle
        key={i}
        className={`is-hot${i % 6 === 0 ? ' cover-twinkle' : ''}`}
        style={i % 6 === 0 ? { animationDelay: `-${(hash(i + 5800) * 4).toFixed(1)}s` } : undefined}
        cx={s.x.toFixed(1)}
        cy={s.y.toFixed(1)}
        r={(s.r * 0.8).toFixed(2)}
        opacity={(0.35 + s.r * 0.3).toFixed(2)}
      />
    ))}
    <g transform="translate(310 75)">
      <g className="cover-breathe">
        {range(8).map((i) => <circle key={i} className="is-glow" r={SHADOW + 14 + i * 10} opacity="0.045" />)}
      </g>
      <g className="cover-turn" style={{ animationDuration: '240s' }}>
        <g className="cover-art__hot" strokeLinecap="round">
          {LENSED.map((s) => <path key={s.d} d={s.d} strokeWidth={s.width.toFixed(2)} opacity="0.55" {...HAIR} />)}
        </g>
      </g>
      <g className="cover-art__glow">{diskSide('back')}</g>
      {band('back')}
      <path className="is-glow" d={arcBand(SHADOW + 18, SHADOW + 30, true)} opacity="0.2" />
      <path className="is-glow" d={arcBand(SHADOW + 8, SHADOW + 18, true)} opacity="0.5" />
      <path className="is-hot" d={arcBand(SHADOW + 1, SHADOW + 8, true)} opacity="0.95" />
      <path className="is-glow" d={arcBand(SHADOW + 4, SHADOW + 10, false)} opacity="0.4" />
      <path className="is-hot" d={arcBand(SHADOW + 1, SHADOW + 4, false)} opacity="0.85" />
      <circle className="is-void" r={SHADOW} />
      <g className="cover-art__hot">
        <circle r={SHADOW + 0.7} strokeWidth="1.8" {...HAIR} />
        <circle r={SHADOW + 3.4} strokeWidth="0.8" opacity="0.45" {...HAIR} />
      </g>
      {band('front')}
      <g className="cover-art__glow">{diskSide('front')}</g>
    </g>
  </g>
);

/**
 * A space telescope after the James Webb, in isometric: the five-layer diamond sunshield
 * lying flat, the eighteen gold hexagons of the primary mirror standing on its tower and
 * tilted back to the sky, the secondary held out in front on its tripod, and the deep
 * field around it — soft galaxies, each a faint halo round a brighter core, and a few
 * near stars with the six-pointed spikes such a mirror gives them.
 */
const TP = isoProjector(300, 112);
const SHIELD = [[-100, 100], [-35, -35], [100, -100], [35, 35]];
const MIRROR_AT = [0, 0, 40];
const MIRROR_U = [Math.SQRT1_2, -Math.SQRT1_2, 0];
const MIRROR_V = [-0.31, -0.31, 0.9];
const MIRROR_N = [0.636, 0.636, 0.438];
const HEX = 9.5;
const SEGMENTS = range(5).flatMap((q) => range(5).map((r) => [q - 2, r - 2]))
  .filter(([q, r]) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 2 && (q || r));

/** A point on the mirror's surface, `a` across it and `b` up it, and a little in front of it by `n`. */
const onMirror = (a, b, n = 0) => TP(...[0, 1, 2].map((i) => MIRROR_AT[i] + a * MIRROR_U[i] + b * MIRROR_V[i] + n * MIRROR_N[i]));

function segment(q, r, size) {
  const [ca, cb] = [Math.sqrt(3) * HEX * (q + r / 2), -1.5 * HEX * r];
  return poly(range(6).map((k) => {
    const t = ((60 * k - 90) * Math.PI) / 180;
    return onMirror(ca + size * Math.cos(t), cb + size * Math.sin(t));
  }));
}

const GALAXIES = [
  [60, 34, 9, 30], [110, 110, 6, -20], [36, 118, 4, 60], [150, 20, 5, 10], [505, 30, 10, -35], [570, 92, 7, 20],
  [470, 128, 5, 70], [600, 20, 4, -10], [530, 70, 3, 40], [420, 14, 4, 0], [205, 14, 3, -40], [90, 74, 3, 15],
];
const SPIKED = [[80, 58, 11], [548, 50, 13], [458, 104, 9], [178, 42, 8], [604, 128, 10]];
const SECONDARY = onMirror(0, 4, 52);
const STRUT_FEET = [[0, -38], [-34, 22], [34, 22]].map(([a, b]) => onMirror(a, b));

const telescope = (
  <g>
    {sky(starfield(5000, 50))}
    {GALAXIES.map(([x, y, r, angle]) => (
      <g key={`${x}-${y}`} transform={`rotate(${angle} ${x} ${y})`}>
        <ellipse className="is-light" cx={x} cy={y} rx={r * 1.9} ry={r * 0.8} opacity="0.45" />
        <ellipse className="is-mid" cx={x} cy={y} rx={r} ry={r * 0.42} opacity="0.75" />
        <circle className="is-full" cx={x} cy={y} r={Math.max(0.8, r * 0.16)} />
      </g>
    ))}
    {SPIKED.map(([x, y, l], i) => (
      <g key={x} className="cover-twinkle" style={{ animationDelay: `-${i * 0.8}s`, animationDuration: `${3 + i * 0.6}s` }}>
        <g className="cover-art__line">
          <path d={`${[90, 30, 150].map((deg) => { const a = (deg * Math.PI) / 180; return `M${pt(x - l * Math.cos(a), y - l * Math.sin(a))}L${pt(x + l * Math.cos(a), y + l * Math.sin(a))}`; }).join('')}M${pt(x - l * 0.4, y)}H${(x + l * 0.4).toFixed(1)}`} strokeWidth="1" {...HAIR} />
        </g>
        <circle className="is-full" cx={x} cy={y} r="1.8" />
      </g>
    ))}
    {range(5).map((k) => (
      <path key={k} className={`${k === 4 ? 'is-light' : 'is-mid'} is-sheet`} d={poly(SHIELD.map(([x, y]) => TP(x, y, k * 3)))} strokeWidth="0.75" {...HAIR} />
    ))}
    <g className="cover-art__line">
      <path d={`M${pt(...TP(0, 0, 12))}L${pt(...onMirror(0, -40))}`} strokeWidth="2.5" {...HAIR} />
    </g>
    <path className="is-full" d={SEGMENTS.map(([q, r]) => segment(q, r, HEX * 1.12)).join('')} />
    {SEGMENTS.map(([q, r], i) => <path key={i} className={hash(i + 5400) > 0.3 ? 'is-mid' : 'is-light'} d={segment(q, r, HEX * 0.93)} />)}
    <g className="cover-art__line">
      <path d={STRUT_FEET.map((f) => `M${pt(...f)}L${pt(...SECONDARY)}`).join('')} strokeWidth="1.25" {...HAIR} />
    </g>
    <circle className="is-full" cx={SECONDARY[0]} cy={SECONDARY[1]} r="3.4" />
  </g>
);

/** The seen space covers, by id. */
export const SPACE_SKY_ART = { station, asteroids, earthrise, ringed, blackhole, telescope };
