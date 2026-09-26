/**
 * The humanities covers: a Doric colonnade, a line of music, a brass orrery, the
 * pyramids of Giza and the Templo Mayor. See CoverArt for how a drawing is made and
 * painted.
 */

import { W, hash, range, HAIR } from './artKit.js';

const pt = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;

/**
 * A Doric colonnade: cornice, a frieze of triglyphs, the architrave, then fluted
 * columns under plain capitals, on three steps, with the shadowed wall behind.
 */
const COLUMNS = range(9).map((i) => 38 + i * 68);
const TRIGLYPHS = range(20).map((i) => 4 + i * 34);

const colonnade = (
  <g transform="translate(0 8)">
    <rect className="is-light" x="0" y="42" width={W} height="78" opacity="0.55" />
    <rect className="is-full" x="0" y="8" width={W} height="8" />
    <rect className="is-mid" x="0" y="16" width={W} height="16" />
    {TRIGLYPHS.map((x) => (
      <g key={x}>
        <rect className="is-full" x={x} y="16" width="12" height="16" />
        <rect className="is-ground" x={x + 3.5} y="18" width="1.6" height="14" />
        <rect className="is-ground" x={x + 6.9} y="18" width="1.6" height="14" />
      </g>
    ))}
    <rect className="is-full" x="0" y="32" width={W} height="10" />
    {COLUMNS.map((cx) => (
      <g key={cx}>
        <rect className="is-full" x={cx - 17} y="42" width="34" height="5" />
        <path className="is-full" d={`M${cx - 17} 47L${cx + 17} 47L${cx + 12} 53L${cx - 12} 53Z`} />
        <path className="is-mid" d={`M${cx - 12} 53L${cx + 12} 53L${cx + 14} 120L${cx - 14} 120Z`} />
        <g className="cover-art__rule">
          {[-2, -1, 0, 1, 2].map((f) => (
            <line key={f} x1={cx + f * 4.4} x2={cx + f * 5.2} y1="56" y2="118" strokeWidth="1" opacity="0.8" {...HAIR} />
          ))}
        </g>
      </g>
    ))}
    <rect className="is-full" x="0" y="120" width={W} height="30" />
    <g className="cover-art__rule">
      <line x1="0" x2={W} y1="129" y2="129" strokeWidth="1.5" {...HAIR} />
      <line x1="0" x2={W} y1="138" y2="138" strokeWidth="1.5" {...HAIR} />
    </g>
  </g>
);

/**
 * Sheet music: the opening of Beethoven's "Ode to Joy" in common time, a faint staff
 * above waiting to be written and the next four bars fainter below. A note is a staff
 * position (0 is the bottom line, E) and a length in beats. When covers move, the
 * opening plays: each note lights as it sounds and dims after (`music-note`).
 */
const ODE_OPENING = [[0, 1], [0, 1], [1, 1], [2, 1], [2, 1], [1, 1], [0, 1], [-1, 1], [-2, 1], [-2, 1], [-1, 1], [0, 1], [0, 1.5], [-1, 0.5], [-1, 2]];
const ODE_ANSWER = [[0, 1], [0, 1], [1, 1], [2, 1], [2, 1], [1, 1], [0, 1], [-1, 1], [-2, 1], [-2, 1], [-1, 1], [0, 1], [-1, 1.5], [-2, 0.5], [-2, 2]];
const LINE_GAP = 9;
const BAR_X = 74;
const BAR_W = 134;

/** One beat of the melody when it plays, and the whole loop: sixteen beats and a rest. */
const BEAT = 0.6;
const PLAY_LOOP = 12;

function staff(top, melody, opacity, key, playing = false) {
  const bottom = top + 4 * LINE_GAP;
  const noteY = (p) => bottom - (p * LINE_GAP) / 2;
  let beat = 0;
  const notes = (melody ?? []).map(([p, len]) => {
    const bar = Math.floor(beat / 4);
    const x = BAR_X + bar * BAR_W + 18 + (beat % 4) * 29;
    const start = beat;
    beat += len;
    return { x, y: noteY(p), p, len, start };
  });
  return (
    <g key={key} opacity={opacity}>
      <g className="cover-art__line">
        {range(5).map((i) => <line key={i} x1="18" x2={W - 12} y1={top + i * LINE_GAP} y2={top + i * LINE_GAP} strokeWidth="1.1" {...HAIR} />)}
        <line x1="18" x2="18" y1={top} y2={bottom} strokeWidth="2" {...HAIR} />
        {melody && range(4).map((b) => <line key={b} x1={BAR_X + (b + 1) * BAR_W} x2={BAR_X + (b + 1) * BAR_W} y1={top} y2={bottom} strokeWidth="1.1" {...HAIR} />)}
        {melody && <line x1={BAR_X + 4 * BAR_W + 4} x2={BAR_X + 4 * BAR_W + 4} y1={top} y2={bottom} strokeWidth="3" {...HAIR} />}
        {notes.map(({ x, y, p, len, start }) => (
          <g key={x} className={playing ? 'music-note' : undefined} style={playing ? { animationDelay: `-${(PLAY_LOOP - start * BEAT).toFixed(2)}s` } : undefined}>
            {p <= -2 && <line x1={x - 8} x2={x + 8} y1={noteY(-2)} y2={noteY(-2)} strokeWidth="1.1" {...HAIR} />}
            <line x1={x + 4.9} x2={x + 4.9} y1={y - 1} y2={y - 30} strokeWidth="1.25" {...HAIR} />
            {len === 0.5 && <path d={`M${pt(x + 4.9, y - 30)}q6 6 7 15`} strokeWidth="1.5" {...HAIR} />}
            <ellipse className={len >= 2 ? undefined : 'is-full'} cx={x} cy={y} rx="5.4" ry="3.9" transform={`rotate(-20 ${x} ${y})`} strokeWidth="1.5" {...HAIR} />
            {len === 1.5 && <circle className="is-full" cx={x + 10} cy={p % 2 === 0 ? y - LINE_GAP / 2 : y} r="1.6" />}
          </g>
        ))}
      </g>
      {melody && (
        <g className="cover-art__fill">
          <text className="cover-art__glyph" x="44" y={top + 2 * LINE_GAP - 1} fontSize="20" textAnchor="middle">4</text>
          <text className="cover-art__glyph" x="44" y={bottom - 1} fontSize="20" textAnchor="middle">4</text>
        </g>
      )}
    </g>
  );
}

const music = (
  <g>
    {staff(3, null, 0.3, 'above')}
    {staff(57, ODE_OPENING, 1, 'main', true)}
    {staff(111, ODE_ANSWER, 0.35, 'below')}
  </g>
);

/**
 * An orrery: the planets on tilted orbits round the sun, each held on its own brass arm,
 * Saturn with its ring and the Earth with its Moon, the whole on a stand.
 *
 * Each planet is drawn on a flat circle that is then squashed into its tilted orbit
 * (`scale(1 TILT)`): an arm turns about the sun by `--from`, and the planet on its end
 * turns back by as much and is unsquashed, so it stays round and upright. When covers
 * move, the arms turn (cover-orbit and cover-upright in CoverArt.css), each in a period that grows
 * with its orbit to the power 1.5, Kepler's third law, and the Moon circles the Earth.
 */
const SUN = [310, 84];
const TILT = 0.3;
const PLANETS = [[40, 2.6], [62, 4], [86, 4.6], [114, 3.4], [158, 11], [204, 9], [248, 6.5], [290, 6.2]].map(([r, size], i) => ({
  r,
  size,
  motion: { '--from': `${(hash(i + 60) * 360).toFixed(1)}deg`, animationDuration: `${(30 * (r / 40) ** 1.5).toFixed(1)}s` },
}));
const EARTH = 2;
const SATURN = 5;

const orrery = (
  <g>
    <rect className="is-full" x={SUN[0] - 3} y={SUN[1]} width="6" height={150 - SUN[1]} />
    <ellipse className="is-full" cx={SUN[0]} cy="147" rx="40" ry="6" />
    <g className="cover-art__line">
      {PLANETS.map((p) => <ellipse key={p.r} cx={SUN[0]} cy={SUN[1]} rx={p.r} ry={p.r * TILT} strokeWidth="1" opacity="0.45" {...HAIR} />)}
      <circle cx={SUN[0]} cy={SUN[1]} r="21" strokeWidth="1.25" {...HAIR} />
    </g>
    <circle className="is-full" cx={SUN[0]} cy={SUN[1]} r="15" />
    <g transform={`translate(${SUN[0]} ${SUN[1]}) scale(1 ${TILT})`}>
      {PLANETS.map((p, i) => (
        <g key={p.r} className="cover-orbit" style={p.motion}>
          <g className="cover-art__line"><line x1="0" y1="0" x2={p.r} y2="0" strokeWidth="1.5" opacity="0.7" {...HAIR} /></g>
          <g transform={`translate(${p.r} 0)`}>
            <g className="cover-upright" style={{ animationDuration: p.motion.animationDuration }}>
              <g transform={`scale(1 ${(1 / TILT).toFixed(4)})`}>
                {i === SATURN && (
                  <g className="cover-art__line"><ellipse rx="19" ry="5" transform="rotate(-18)" strokeWidth="2" {...HAIR} /></g>
                )}
                {i === EARTH && (
                  <>
                    <g className="cover-art__line"><circle r="10" strokeWidth="1" opacity="0.6" {...HAIR} /></g>
                    <g className="cover-turn"><circle className="is-full" cx="10" r="1.8" /></g>
                  </>
                )}
                <circle className={i % 2 ? 'is-mid' : 'is-full'} r={p.size} />
              </g>
            </g>
          </g>
        </g>
      ))}
    </g>
  </g>
);

/** Where the land (or the lake) meets the sky in both pyramid covers. */
const GROUND = 116;

/** The points of a pyramid's outline at height `y`: its left and right faces. */
function facesAt([x0, x1, apex, top], y) {
  const f = (GROUND - y) / (GROUND - top);
  return [x0 + (apex - x0) * f, x1 + (apex - x1) * f];
}

/**
 * The pyramids of Giza: Khafre's behind, Khufu's in front, Menkaure's and two queens'
 * pyramids trailing off, each with its lit face and its courses of stone, on the sand
 * under a low sun.
 */
const GIZA = [[260, 460, 360, 46], [90, 280, 185, 40], [450, 540, 495, 80], [548, 580, 564, 100], [584, 612, 598, 102]];

const giza = (
  <g>
    <circle className="is-light" cx="80" cy="40" r="14" />
    <rect className="is-light" x="0" y={GROUND} width={W} height={150 - GROUND} />
    <path className="is-mid" d={`M0 128Q120 120 240 127T480 124T${W} 126V150H0Z`} opacity="0.5" />
    {GIZA.map((pyramid) => {
      const [x0, x1, apex, top] = pyramid;
      const ridge = x0 + (x1 - x0) * 0.65;
      return (
        <g key={x0}>
          <path className="is-mid" d={`M${x0} ${GROUND}L${apex} ${top}L${ridge} ${GROUND}Z`} />
          <path className="is-full" d={`M${apex} ${top}L${x1} ${GROUND}L${ridge} ${GROUND}Z`} />
          <g className="cover-art__rule" opacity="0.35">
            {range(Math.floor((GROUND - top) / 6)).map((i) => {
              const y = GROUND - 6 * (i + 1);
              const [l, r] = facesAt(pyramid, y);
              return <line key={y} x1={l} x2={r} y1={y} y2={y} strokeWidth="1" {...HAIR} />;
            })}
          </g>
        </g>
      );
    })}
  </g>
);

/**
 * The Templo Mayor of Tenochtitlan: sloped terraces climbed by a double stair to the
 * twin temples of Tlaloc (the striped crest) and Huitzilopochtli (the stepped
 * merlons), on the lake, with the snow-capped volcanoes on the horizon.
 */
const TEMPLO_TIERS = range(4).map((i) => {
  const w = 300 - i * 40;
  return { x0: 310 - w / 2, x1: 310 + w / 2, yb: GROUND - i * 12, yt: GROUND - (i + 1) * 12 };
});
const PLATFORM = GROUND - 4 * 12;
const STAIRS = [283, 315];

const aztec = (
  <g transform="translate(0 4)">
    <path className="is-light" d={`M0 ${GROUND}L62 70L78 64L98 66L122 74L205 ${GROUND}Z`} />
    <path className="is-ground" d="M62 70L78 64L98 66L110 70L94 74L80 70L70 75Z" opacity="0.8" />
    <path className="is-light" d={`M420 ${GROUND}L510 60L528 57L546 60L${W} 96V${GROUND}Z`} />
    <path className="is-ground" d="M510 60L528 57L546 60L540 66L528 62L516 67Z" opacity="0.8" />
    <rect className="is-light" x="0" y={GROUND} width={W} height={150 - GROUND} />
    <g className="cover-art__line" opacity="0.4">
      {range(24).map((i) => {
        const x = hash(i + 1500) * W;
        const y = GROUND + 6 + hash(i + 1600) * 26;
        return <line key={i} x1={x} x2={x + 10 + hash(i + 1700) * 18} y1={y} y2={y} strokeWidth="1" {...HAIR} />;
      })}
    </g>
    {TEMPLO_TIERS.map((t) => <path key={t.yb} className="is-full" d={`M${t.x0} ${t.yb}L${t.x0 + 5} ${t.yt}L${t.x1 - 5} ${t.yt}L${t.x1} ${t.yb}Z`} />)}
    <g className="cover-art__rule">
      {TEMPLO_TIERS.slice(1).map((t) => <line key={t.yb} x1={t.x0} x2={t.x1} y1={t.yb} y2={t.yb} strokeWidth="1.5" {...HAIR} />)}
    </g>
    {STAIRS.map((x) => (
      <g key={x}>
        <rect className="is-light" x={x} y={PLATFORM} width="22" height={GROUND - PLATFORM} />
        <g className="cover-art__rule">
          {range(14).map((i) => <line key={i} x1={x} x2={x + 22} y1={PLATFORM + 2 + i * 3.5} y2={PLATFORM + 2 + i * 3.5} strokeWidth="1" {...HAIR} />)}
        </g>
      </g>
    ))}
    <rect className="is-mid" x="279" y={PLATFORM} width="4" height={GROUND - PLATFORM} />
    <rect className="is-mid" x="337" y={PLATFORM} width="4" height={GROUND - PLATFORM} />
    {[238, 320].map((x) => (
      <g key={x}>
        <rect className="is-mid" x={x} y={PLATFORM - 20} width="62" height="20" />
        <rect className="is-ground" x={x + 24} y={PLATFORM - 12} width="14" height="12" />
      </g>
    ))}
    <rect className="is-full" x="238" y={PLATFORM - 27} width="62" height="7" />
    <g className="cover-art__rule">
      {range(11).map((i) => <line key={i} x1={242 + i * 5.4} x2={242 + i * 5.4} y1={PLATFORM - 26} y2={PLATFORM - 21} strokeWidth="1.25" {...HAIR} />)}
    </g>
    <rect className="is-full" x="320" y={PLATFORM - 24} width="62" height="4" />
    {range(7).map((i) => <rect key={i} className="is-full" x={321 + i * 9} y={PLATFORM - 30} width="5" height="6" />)}
  </g>
);

/** The humanities covers, by id. */
export const HUMANITIES_ART = { colonnade, music, orrery, giza, aztec };
