/**
 * The space covers of great structures seen from space: the space elevator's ring
 * station over the Earth, and an orbital shipyard. The isometric builds are in
 * spaceIsoArt. See CoverArt for how a drawing is made and painted; what moves is on the
 * classes CoverArt.css animates (cover-turn, flow-dash, cover-carry, cover-hover,
 * cover-flicker, cover-twinkle).
 */

import { hash, range, HAIR } from './artKit.js';
import { pt, starfield, ellipseHalves } from './spaceKit.js';
import { sky } from './spaceParts.jsx';

/**
 * The space elevator from orbit: the Earth's curve below, the tether rising from its
 * anchor straight out of the banner, and round the tether the great ring station — its
 * habitat torus on spokes about a hub, a lighter structural ring beyond it, docking
 * modules on its rim — with a smaller station higher up and climbers riding the tether
 * (still, each rests on a clear stretch of it, `--rest-y`).
 * Rings are drawn in halves round the tether: far half, tether and hubs, near half. When
 * covers move, the ring turns (spokes and window lights) and the climbers rise.
 */
const RING = { cy: 74, rx: 176, ry: 30 };
const RING_HALVES = ellipseHalves(RING.rx, RING.ry);
const TRUSS = ellipseHalves(206, 36);
const UPPER = { cy: 30, halves: ellipseHalves(44, 7.5) };
const MODULES = [0.55, 1.2, 1.94, 2.6].map((t) => [RING.rx * Math.cos(t), RING.ry * Math.sin(t)]);

/**
 * A station's hub where the tether passes through it: a drum with a rounded underside,
 * shaded away from the light and banded by two collars, tapering above and below into
 * cones that close on the tether — each a true cone, its ends ellipses and its far side
 * in shade.
 */
function hub(cy, r, half, cone) {
  const ry = r * 0.25;
  const [top, bottom] = [cy - half, cy + half];
  const front = (y) => `M${310 - r} ${y}A${r} ${ry} 0 0 0 ${310 + r} ${y}`;
  const [rb, rt] = [r * 0.8, 2.2];
  const [eb, et] = [rb * 0.25, rt * 0.25];
  return (
    <g>
      <path className="is-mid is-sheet" d={`M${310 - rb} ${bottom}L${310 - rt} ${bottom + cone}A${rt} ${et} 0 0 0 ${310 + rt} ${bottom + cone}L${310 + rb} ${bottom}Z`} strokeWidth="0.75" {...HAIR} />
      <path className="is-full" d={`M310 ${bottom + eb}L310 ${bottom + cone + et}A${rt} ${et} 0 0 0 ${310 + rt} ${bottom + cone}L${310 + rb} ${bottom}Z`} opacity="0.55" />
      <path className="is-mid is-sheet" d={`M${310 - r} ${top}V${bottom}A${r} ${ry} 0 0 0 ${310 + r} ${bottom}V${top}Z`} strokeWidth="0.75" {...HAIR} />
      <path className="is-full" d={`M${310 + r * 0.35} ${top + ry * 0.94}V${bottom + ry * 0.94}A${r} ${ry} 0 0 0 ${310 + r} ${bottom}V${top}Z`} opacity="0.55" />
      <g className="cover-art__rule" opacity="0.8">
        <path d={`${front(cy - half / 3)}${front(cy + half / 3)}`} strokeWidth="1.25" {...HAIR} />
      </g>
      <ellipse className="is-light is-sheet" cx="310" cy={top} rx={r} ry={ry} strokeWidth="0.75" {...HAIR} />
      <path className="is-mid is-sheet" d={`M${310 - rb} ${top}A${rb} ${eb} 0 0 0 ${310 + rb} ${top}L${310 + rt} ${top - cone}L${310 - rt} ${top - cone}Z`} strokeWidth="0.75" {...HAIR} />
      <path className="is-full" d={`M310 ${top + eb}A${rb} ${eb} 0 0 0 ${310 + rb} ${top}L${310 + rt} ${top - cone}L310 ${top - cone + et}Z`} opacity="0.55" />
      <ellipse className="is-light is-sheet" cx="310" cy={top - cone} rx={rt} ry={et} strokeWidth="0.5" {...HAIR} />
    </g>
  );
}

/**
 * A climber riding the tether: a small drum like the hubs — curved underside, far side in
 * shade, a lit cap, a collar with a window — gripping the tether through short cones.
 */
function climber(cy, r, half) {
  const ry = r * 0.28;
  const [top, bottom] = [cy - half, cy + half];
  const [rb, rt, cone] = [r * 0.85, 1.6, 3.5];
  const [eb, et] = [rb * 0.28, rt * 0.28];
  return (
    <>
      <path className="is-mid is-sheet" d={`M${310 - rb} ${bottom}L${310 - rt} ${bottom + cone}A${rt} ${et} 0 0 0 ${310 + rt} ${bottom + cone}L${310 + rb} ${bottom}Z`} strokeWidth="0.5" {...HAIR} />
      <path className="is-full" d={`M310 ${bottom + eb}L310 ${bottom + cone + et}A${rt} ${et} 0 0 0 ${310 + rt} ${bottom + cone}L${310 + rb} ${bottom}Z`} opacity="0.55" />
      <path className="is-mid is-sheet" d={`M${310 - r} ${top}V${bottom}A${r} ${ry} 0 0 0 ${310 + r} ${bottom}V${top}Z`} strokeWidth="0.6" {...HAIR} />
      <path className="is-full" d={`M${310 + r * 0.35} ${top + ry * 0.94}V${bottom + ry * 0.94}A${r} ${ry} 0 0 0 ${310 + r} ${bottom}V${top}Z`} opacity="0.55" />
      <g className="cover-art__rule" opacity="0.8">
        <path d={`M${310 - r} ${cy}A${r} ${ry} 0 0 0 ${310 + r} ${cy}`} strokeWidth="1" {...HAIR} />
      </g>
      <rect className="is-ground" x="308.2" y={cy - 2.4} width="2" height="1.6" rx="0.5" opacity="0.9" />
      <ellipse className="is-light is-sheet" cx="310" cy={top} rx={r} ry={ry} strokeWidth="0.6" {...HAIR} />
      <path className="is-mid is-sheet" d={`M${310 - rb} ${top}A${rb} ${eb} 0 0 0 ${310 + rb} ${top}L${310 + rt} ${top - cone}L${310 - rt} ${top - cone}Z`} strokeWidth="0.5" {...HAIR} />
      <path className="is-full" d={`M310 ${top + eb}A${rb} ${eb} 0 0 0 ${310 + rb} ${top}L${310 + rt} ${top - cone}L310 ${top - cone + et}Z`} opacity="0.55" />
      <ellipse className="is-light" cx="310" cy={top - cone} rx={rt} ry={et} />
    </>
  );
}

const elevator = (
  <g>
    {sky(starfield(3100, 90, 0, 115))}
    <circle className="is-light" cx="310" cy="480" r="370" />
    <g className="cover-art__line"><circle cx="310" cy="480" r="377" strokeWidth="4" opacity="0.3" {...HAIR} /></g>
    <g className="cover-art__rule" opacity="0.8">
      <circle cx="310" cy="480" r="360" strokeWidth="2" strokeDasharray="34 16 10 26" {...HAIR} />
      <circle cx="310" cy="480" r="347" strokeWidth="1.5" strokeDasharray="14 30 44 12" {...HAIR} />
    </g>
    <path className="is-full" d="M298 113L322 113L317 105L303 105Z" />
    <g transform={`translate(310 ${RING.cy})`}>
      <g className="cover-art__line"><path d={TRUSS.back} strokeWidth="1.25" opacity="0.55" {...HAIR} /></g>
      <path className="is-stroke-mid" d={RING_HALVES.back} fill="none" strokeWidth="11" />
      <g className="cover-art__rule">
        <path className="flow-dash" style={{ animationDuration: '3s' }} d={RING_HALVES.back} strokeWidth="2.5" strokeDasharray="2 8" {...HAIR} />
      </g>
      <g transform={`scale(1 ${(RING.ry / RING.rx).toFixed(4)})`}>
        <g className="cover-turn" style={{ animationDuration: '70s' }}>
          <g className="cover-art__line">
            {range(8).map((i) => {
              const a = (i / 8) * Math.PI * 2;
              return <line key={i} x1={(16 * Math.cos(a)).toFixed(1)} y1={(16 * Math.sin(a)).toFixed(1)} x2={(RING.rx * Math.cos(a)).toFixed(1)} y2={(RING.rx * Math.sin(a)).toFixed(1)} strokeWidth="2" {...HAIR} />;
            })}
          </g>
        </g>
      </g>
    </g>
    <g transform={`translate(310 ${UPPER.cy})`}>
      <path className="is-stroke-mid" d={UPPER.halves.back} fill="none" strokeWidth="5" />
    </g>
    <rect className="is-full" x="308.5" y="-10" width="3" height="116" />
    {[[0, -50], [5, -87], [10, -23]].map(([s, rest]) => (
      <g key={s} className="cover-carry" style={{ '--dx': '0px', '--dy': '-130px', '--rest-y': `${rest}px`, animationDuration: '15s', animationDelay: `-${s}s` }}>
        {climber(97, 3.6, 4.5)}
      </g>
    ))}
    {hub(RING.cy, 13, 11, 9)}
    {hub(UPPER.cy, 7, 6, 5)}
    <g transform={`translate(310 ${UPPER.cy})`}>
      <path className="is-stroke-full" d={UPPER.halves.front} fill="none" strokeWidth="5" />
    </g>
    <g transform={`translate(310 ${RING.cy})`}>
      <path className="is-stroke-full" d={RING_HALVES.front} fill="none" strokeWidth="11" />
      <g className="cover-art__rule">
        <path className="flow-dash" style={{ animationDuration: '3s' }} d={RING_HALVES.front} strokeWidth="2.5" strokeDasharray="2 8" {...HAIR} />
      </g>
      {MODULES.map(([x, y]) => <rect key={x} className="is-mid is-sheet" x={(x - 7).toFixed(1)} y={(y + 3).toFixed(1)} width="14" height="7" rx="3.5" strokeWidth="0.75" {...HAIR} />)}
      <g className="cover-art__line"><path d={TRUSS.front} strokeWidth="1.25" opacity="0.55" {...HAIR} /></g>
      {[-1, 1].map((side) => (
        <circle key={side} className="is-full cover-twinkle" style={{ animationDuration: '2s', animationDelay: side < 0 ? '-1s' : '0s' }} cx={side * RING.rx} cy="0" r="2.4" />
      ))}
    </g>
  </g>
);

/**
 * An orbital shipyard: a truss frame round a ship being built. Its bow is finished,
 * panelled and windowed; its stern is still ribs on a keel. Welding sparks flicker
 * where the two meet, robot arms reach in from the frame, drones hover, cargo pods wait,
 * and a planet's limb fills the corner.
 */
const BAYS = range(10).map((i) => 104 + i * 48);
const RIBS = range(10).map((i) => 168 + i * 14);
const SEAM = [[300, 60], [301, 76], [300, 92]];

const truss = (opacity, front) => (
  <g className="cover-art__line" opacity={opacity}>
    {!front && <path d="M104 34H536M104 38H536" strokeWidth="1.5" {...HAIR} />}
    <path d="M104 114H536M104 118H536" strokeWidth="1.5" {...HAIR} />
    {BAYS.filter((_, i) => !front || i % 2 === 0).map((x) => <line key={x} x1={x} x2={x} y1="34" y2="118" strokeWidth="1.5" {...HAIR} />)}
    {!front && <path d={BAYS.slice(0, -1).map((x) => `M${x} 38L${x + 48} 114M${x + 48} 38L${x} 114`).join('')} strokeWidth="0.75" {...HAIR} />}
  </g>
);

const shipyard = (
  <g>
    {sky(starfield(3300, 60))}
    <circle className="is-light" cx="40" cy="250" r="170" />
    <g className="cover-art__line"><circle cx="40" cy="250" r="177" strokeWidth="2" opacity="0.35" {...HAIR} /></g>
    {truss(0.4, false)}
    <g className="cover-art__line" opacity="0.85">
      <path d="M160 62L300 59M160 90L300 93" strokeWidth="2" {...HAIR} />
      {RIBS.map((x) => <ellipse key={x} cx={x} cy="76" rx="4" ry={14 + ((x - 160) / 140) * 2.5} strokeWidth="1.25" {...HAIR} />)}
    </g>
    <rect className="is-mid" x="154" y="60" width="10" height="32" />
    {[66, 76, 86].map((y) => <path key={y} className="is-full" d={`M154 ${y - 3}L140 ${y - 6}L140 ${y + 6}L154 ${y + 3}Z`} />)}
    <path className="is-mid" d="M300 59L430 58Q495 62 505 76Q495 90 430 94L300 93Z" />
    <g className="cover-art__rule" opacity="0.8">
      <path d={`${range(6).map((i) => `M${322 + i * 22} 59V93`).join('')}M300 76H470`} strokeWidth="1" {...HAIR} />
    </g>
    <g className="cover-art__ground">
      {range(13).map((i) => <circle key={i} cx={330 + i * 9} cy="68" r="1.3" />)}
    </g>
    <ellipse className="is-light" cx="458" cy="61" rx="12" ry="4" />
    <g className="cover-art__line" strokeLinejoin="round">
      <path d="M280 38L262 50L296 58M282 114L262 104L296 94" strokeWidth="2.5" {...HAIR} />
    </g>
    <g className="cover-art__fill">
      {[[280, 38], [262, 50], [282, 114], [262, 104]].map(([x, y]) => <circle key={`${x}-${y}`} cx={x} cy={y} r="2.6" />)}
    </g>
    {SEAM.map(([x, y], i) => (
      <g key={y} className="cover-flicker" style={{ animationDelay: `-${(i * 0.37).toFixed(2)}s` }}>
        <g className="cover-art__line">
          <path d={range(7).map((k) => { const a = (k / 7) * Math.PI * 2 + i; const l = 4 + hash(k + i * 9) * 5; return `M${pt(x, y)}L${pt(x + Math.cos(a) * l, y + Math.sin(a) * l)}`; }).join('')} strokeWidth="1" {...HAIR} />
        </g>
        <circle className="is-ground" cx={x} cy={y} r="1.8" />
      </g>
    ))}
    {truss(0.85, true)}
    {[[380, 44, 3], [220, 106, 4]].map(([x, y, s]) => (
      <g key={x} className="cover-hover" style={{ '--hover': '3px', animationDuration: `${s}s` }}>
        <rect className="is-full" x={x - 5} y={y - 2} width="10" height="4" rx="1" />
        <g className="cover-art__line"><path d={`M${x - 8} ${y - 4}H${x - 2}M${x + 2} ${y - 4}H${x + 8}`} strokeWidth="1" {...HAIR} /></g>
      </g>
    ))}
    {[[548, 96, 'is-mid'], [564, 96, 'is-full'], [556, 84, 'is-mid'], [580, 96, 'is-mid']].map(([x, y, tone]) => (
      <g key={`${x}-${y}`}>
        <rect className={`${tone} is-sheet`} x={x} y={y} width="15" height="11" strokeWidth="0.75" {...HAIR} />
        <g className="cover-art__rule"><line x1={x + 5} x2={x + 5} y1={y + 1} y2={y + 10} strokeWidth="1" {...HAIR} /></g>
      </g>
    ))}
  </g>
);

/** The great-structure space covers, by id. */
export const SPACE_WORKS_ART = { elevator, shipyard };
