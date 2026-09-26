/**
 * The physical-science covers: the periodic table, DNA, light through two slits, a
 * crystal and an atom. See CoverArt for how a drawing is made and painted.
 */

import { W, hash, range, HAIR } from './artKit.js';

const pt = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;

/**
 * The periodic table's first five periods, by the columns each fills: the gap over the
 * transition metals is what makes it recognisable. Tiles are shaded by block (s, d, p,
 * and the noble gases), each with a cut where the number and the symbol would be.
 */
const FULL_PERIOD = range(18).map((i) => i + 1);
const PERIODS = [[1, 18], [1, 2, 13, 14, 15, 16, 17, 18], [1, 2, 13, 14, 15, 16, 17, 18], FULL_PERIOD, FULL_PERIOD];
const CELL = 19.5;
const PITCH = 22;
const TABLE_X = (W - 18 * PITCH + (PITCH - CELL)) / 2;
const TABLE_Y = 20;

function blockTone(column) {
  if (column <= 2 || column === 18) return 'is-full';
  return column >= 13 ? 'is-mid' : 'is-light';
}

const periodic = (
  <g>
    {PERIODS.flatMap((columns, row) => columns.map((column) => {
      const x = TABLE_X + (column - 1) * PITCH;
      const y = TABLE_Y + row * PITCH;
      return (
        <g key={`${row}-${column}`}>
          <rect className={blockTone(column)} x={x} y={y} width={CELL} height={CELL} rx="2" />
          <rect className="is-ground" x={x + 2.5} y={y + 2.5} width="4" height="1.6" />
          <rect className="is-ground" x={x + 5} y={y + 7.5} width="9.5" height="6" rx="1" />
        </g>
      );
    }))}
  </g>
);

/**
 * The double helix: two backbones a half-turn apart, crossing every half wavelength —
 * each crossing swaps which strand is in front — with the base pairs as rungs between.
 */
const LAMBDA = 150;
const strandY = (x, strand) => 75 + 32 * Math.sin((2 * Math.PI * x) / LAMBDA + strand * Math.PI);

function strandPath(strand, from, to) {
  const pts = [];
  for (let x = from; x <= to + 0.1; x += 3) pts.push(pt(x, strandY(x, strand)));
  return `M${pts.join('L')}`;
}

const HALF_TURNS = range(Math.ceil((W + LAMBDA) / (LAMBDA / 2)) + 1).map((s) => ({ s, from: s * (LAMBDA / 2), to: (s + 1) * (LAMBDA / 2) }));
const RUNGS = range(78).map((i) => ({ i, x: 5 + i * 10 })).filter(({ x }) => Math.abs(strandY(x, 0) - strandY(x, 1)) > 8);

const helix = (
  <g className="cover-art__line" strokeLinecap="round">
    <g className="cover-slide" style={{ '--slide': `-${LAMBDA}px`, animationDuration: '14s' }}>
    {HALF_TURNS.map(({ s, from, to }) => (
      <path key={`b${s}`} d={strandPath((s + 1) % 2, from, to)} strokeWidth="6" opacity="0.4" />
    ))}
    {RUNGS.map(({ i, x }) => {
      const a = strandY(x, 0);
      const b = strandY(x, 1);
      const mid = (a + b) / 2;
      const gap = Math.sign(b - a) * 1.5;
      return (
        <g key={x} opacity={hash(i % 15) > 0.5 ? 0.7 : 0.45}>
          <line x1={x} x2={x} y1={a} y2={mid - gap} strokeWidth="2.25" {...HAIR} />
          <line x1={x} x2={x} y1={mid + gap} y2={b} strokeWidth="2.25" opacity="0.6" {...HAIR} />
        </g>
      );
    })}
    {HALF_TURNS.map(({ s, from, to }) => (
      <path key={`f${s}`} d={strandPath(s % 2, from, to)} strokeWidth="6" />
    ))}
    </g>
  </g>
);

/**
 * Wave interference: Young's two slits just below the banner, each sending out its own
 * ripples; where the rings cross they draw the fringes. When covers move, every ring
 * grows by one wavelength and starts again (the wave-ring class in CoverArt.css), so the
 * waves travel outward through fringes that stay where they are.
 */
const WAVELENGTH = 15;

const waves = (
  <g className="cover-art__line">
    {[282, 338].flatMap((x) => range(31).map((i) => (
      <circle
        key={`${x}-${i}`}
        className="wave-ring"
        style={{ '--r0': `${i * WAVELENGTH}px`, '--r1': `${(i + 1) * WAVELENGTH}px` }}
        cx={x}
        cy="162"
        r={i * WAVELENGTH}
        strokeWidth="1.25"
        opacity={0.75 - i * 0.012}
        {...HAIR}
      />
    )))}
  </g>
);

/**
 * A crystal lattice: a honeycomb of atoms and bonds, like graphite's sheets. Here and
 * there a ring is shaded with its aromatic circle drawn in, and a heavier atom sits in
 * the lattice.
 */
const BOND = 18;
const HEXES = range(8).flatMap((row) => range(21).map((col) => ({
  k: row * 21 + col,
  x: col * BOND * Math.sqrt(3) + (row % 2 ? (BOND * Math.sqrt(3)) / 2 : 0),
  y: row * BOND * 1.5,
})));

const corners = ({ x, y }) => range(6).map((i) => {
  const a = Math.PI / 6 + (i * Math.PI) / 3;
  return [x + BOND * Math.cos(a), y + BOND * Math.sin(a)];
});

const ATOMS = new Map();
const BONDS = new Map();
HEXES.forEach((hex) => {
  const c = corners(hex);
  c.forEach(([x, y], i) => {
    const id = `${Math.round(x)},${Math.round(y)}`;
    ATOMS.set(id, { x, y });
    const [nx, ny] = c[(i + 1) % 6];
    const next = `${Math.round(nx)},${Math.round(ny)}`;
    BONDS.set(id < next ? `${id}|${next}` : `${next}|${id}`, `M${pt(x, y)}L${pt(nx, ny)}`);
  });
});

const lattice = (
  <g>
    {HEXES.filter(({ k }) => hash(k + 31) > 0.82).map((hex) => (
      <g key={hex.k}>
        <path className="is-light" d={`M${corners(hex).map(([x, y]) => pt(x, y)).join('L')}Z`} />
        <g className="cover-art__line"><circle cx={hex.x} cy={hex.y} r={BOND * 0.52} strokeWidth="1.25" {...HAIR} /></g>
      </g>
    ))}
    <g className="cover-art__line">
      <path d={[...BONDS.values()].join('')} strokeWidth="1.5" opacity="0.8" {...HAIR} />
    </g>
    {[...ATOMS.entries()].map(([id, { x, y }], i) => (
      hash(i + 400) > 0.92
        ? <circle key={id} className="is-mid is-sheet" cx={x} cy={y} r="5" strokeWidth="1.5" {...HAIR} />
        : <circle key={id} className="is-full" cx={x} cy={y} r="2.8" />
    ))}
  </g>
);

/**
 * An atom, in the classic picture: a nucleus of protons and neutrons packed on a
 * sunflower spiral, three electron orbits crossing around it with their electrons, and
 * the energy levels as faint rings behind.
 */
const NUCLEUS = range(19).map((i) => ({
  x: 310 + 4.4 * Math.sqrt(i) * Math.cos(i * 2.39996),
  y: 75 + 4.4 * Math.sqrt(i) * Math.sin(i * 2.39996),
  proton: hash(i + 40) > 0.5,
}));
const ORBITS = [0, 32, -32];
const FLATTEN = 38 / 150;

/**
 * Each orbit's electrons, drawn like the orrery's planets: turned about the nucleus on a
 * circle squashed into the orbit, then turned back and unsquashed so they stay round.
 */
const ELECTRON_ORBITS = ORBITS.map((deg, o) => ({
  deg,
  period: `${9 + o * 3}s`,
  electrons: [0.7 + o, 3.9 + o * 1.3].map((t) => `${((t * 180) / Math.PI).toFixed(1)}deg`),
}));

const atom = (
  <g>
    <g className="cover-art__line">
      {range(13).map((i) => <circle key={i} cx="310" cy="75" r={40 + i * 24} strokeWidth="1" opacity="0.16" {...HAIR} />)}
      {ORBITS.map((deg) => (
        <ellipse key={deg} cx="310" cy="75" rx="150" ry="38" transform={`rotate(${deg} 310 75)`} strokeWidth="1.5" {...HAIR} />
      ))}
    </g>
    {ELECTRON_ORBITS.map(({ deg, period, electrons }) => (
      <g key={deg} transform={`translate(310 75) rotate(${deg}) scale(1 ${FLATTEN.toFixed(4)})`}>
        {electrons.map((from) => (
          <g key={from} className="cover-orbit" style={{ '--from': from, animationDuration: period }}>
            <g transform="translate(150 0)">
              <g className="cover-upright" style={{ animationDuration: period }}>
                <g className="cover-art__fill" transform={`scale(1 ${(1 / FLATTEN).toFixed(4)})`}>
                  <circle r="8.5" opacity="0.18" />
                  <circle r="4.2" />
                </g>
              </g>
            </g>
          </g>
        ))}
      </g>
    ))}
    {NUCLEUS.map(({ x, y, proton }) => (
      <circle key={`${x}-${y}`} className={`${proton ? 'is-full' : 'is-mid'} is-sheet`} cx={x} cy={y} r="5.4" strokeWidth="1" {...HAIR} />
    ))}
  </g>
);

/** The physical-science covers, by id. */
export const SCIENCE_ART = { periodic, helix, waves, lattice, atom };
