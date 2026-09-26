/**
 * The space covers built in isometric: a factory network, an asteroid refinery, a
 * planetary base and a maglev launch track. One rule holds for all four: everything
 * stands on the same grid (spaceKit's projection, world x down to the right, y down to
 * the left, z up), every part is a real solid — box, slab, cylinder, dome — lit the same
 * way (top light, left face mid, right face full), and parts are drawn far to near by
 * their depth, x + y. What moves is on the classes CoverArt.css animates (belt-items,
 * cover-carry, cover-hover, cover-twinkle, maglev-run, maglev-coil).
 */

import { W, hash, range, HAIR } from './artKit.js';
import { pt, poly, starfield, isoProjector, isoBox, isoCylinder, isoSlab, isoCircle, isoDome, rock } from './spaceKit.js';
import { box, cylinder, sky, belt } from './spaceParts.jsx';

/** Parts collected with their depth, drawn far to near. */
function scene() {
  const parts = [];
  return {
    put: (depth, el) => parts.push({ depth, el, order: parts.length }),
    draw: () => parts.sort((a, b) => a.depth - b.depth || a.order - b.order).map((p) => p.el),
  };
}

/** A lattice tower from a square foot to an apex, with its braces. */
function lattice(P, x, y, foot, top, key) {
  const legs = [[-foot, -foot], [foot, -foot], [foot, foot], [-foot, foot]];
  const levels = [0, 0.3, 0.6].map((f) => legs.map(([dx, dy]) => P(x + dx * (1 - f), y + dy * (1 - f), f * top)));
  const apex = P(x, y, top);
  return (
    <g key={key} className="cover-art__line" strokeLinejoin="round">
      {legs.map((_, i) => <path key={i} d={`M${pt(...levels[0][i])}L${pt(...apex)}`} strokeWidth="1.75" {...HAIR} />)}
      {levels.slice(1).map((ring, i) => <path key={i} d={poly(ring)} strokeWidth="1" opacity="0.8" {...HAIR} />)}
      <path d={levels.slice(0, -1).map((ring, i) => `M${pt(...ring[1])}L${pt(...levels[i + 1][2])}M${pt(...ring[2])}L${pt(...levels[i + 1][3])}`).join('')} strokeWidth="0.75" opacity="0.7" {...HAIR} />
    </g>
  );
}

/**
 * A drill bit boring into the ground at world (x, y): its fluted body from `bottom` up to
 * `top` — stacked flights, each a disc shaded on its far side, round the shaft — ending
 * in a cone whose point is down in the bore.
 */
function drillBit(P, x, y, bottom, top) {
  const r = 5.5;
  const flights = range(5).map((k) => bottom + 4 + ((top - bottom - 4) * k) / 4);
  const [cx, tipY] = P(x, y, bottom - 6);
  const [, baseY] = P(x, y, bottom + 4);
  return (
    <g key="drill-bit">
      <path className="is-full is-sheet" d={`M${pt(cx - r * 1.22, baseY)}L${pt(cx, tipY)}L${pt(cx + r * 1.22, baseY)}Z`} strokeWidth="0.75" {...HAIR} />
      <path className="is-mid" d={`M${pt(cx - r * 1.22, baseY)}L${pt(cx, tipY)}L${pt(cx, baseY + r * 0.7)}Z`} opacity="0.8" />
      <g className="cover-art__line"><path d={`M${pt(...P(x, y, bottom))}L${pt(...P(x, y, top))}`} strokeWidth="2.5" {...HAIR} /></g>
      {flights.map((z, k) => (
        <g key={z}>
          <path className={`${k % 2 ? 'is-light' : 'is-mid'} is-sheet`} d={isoCircle(P, [x, y, z], r * (1 - k * 0.06))} strokeWidth="0.75" {...HAIR} />
        </g>
      ))}
    </g>
  );
}

/** A solar panel tilted up toward +y, from world (x, y), `w` along x. */
function panel(P, x, y, w, key) {
  const q = [P(x, y, 3), P(x + w, y, 3), P(x + w, y + 9, 10), P(x, y + 9, 10)];
  return (
    <g key={key}>
      <path className="is-mid is-sheet" d={poly(q)} strokeWidth="0.75" {...HAIR} />
      <g className="cover-art__rule">
        <path d={`M${pt(...P(x + w / 3, y, 3))}L${pt(...P(x + w / 3, y + 9, 10))}M${pt(...P(x + (2 * w) / 3, y, 3))}L${pt(...P(x + (2 * w) / 3, y + 9, 10))}`} strokeWidth="0.75" {...HAIR} />
      </g>
    </g>
  );
}

/** The floor's tile grid over the whole banner. */
function floorGrid(P, tile, reach, opacity) {
  return (
    <g className="cover-art__line">
      <path
        d={range(Math.round((2 * reach) / tile) + 1).flatMap((i) => {
          const k = -reach + i * tile;
          return [`M${pt(...P(k, -reach))}L${pt(...P(k, reach))}`, `M${pt(...P(-reach, k))}L${pt(...P(reach, k))}`];
        }).join('')}
        strokeWidth="1"
        opacity={opacity}
        {...HAIR}
      />
    </g>
  );
}

/**
 * A factory network: three assembly hubs in a row across the floor. Each hub is fed from
 * behind by a smelter (along x) and a constructor (along y); the first also takes ore from
 * a miner in front, and each hands its output to the next along a belt that runs out
 * along x and turns up y into the next hub's front. The last fills a storage container.
 * Power poles and their cables stand behind; fluid tanks sit between the hubs.
 */
const FP = isoProjector(310, 92);
const HUBS = [[-140, 140], [0, 0], [140, -140]];
const ARM = 64;

function factoryParts() {
  const s = scene();
  HUBS.forEach(([hx, hy], h) => {
    const d = hx + hy;
    s.put(d, (
      <g key={`hub${h}`}>
        {box(isoBox(FP, hx - 16, hy - 16, 0, 32, 32, 26))}
        {box(isoBox(FP, hx - 12, hy - 12, 26, 10, 10, 8))}
        {box(isoBox(FP, hx + 2, hy - 12, 26, 10, 10, 6))}
      </g>
    ));
    const sx = hx - ARM;
    s.put(d - ARM, (
      <g key={`smelter${h}`}>
        {box(isoBox(FP, sx - 12, hy - 12, 0, 24, 24, 18))}
        {box(isoBox(FP, sx - 10, hy - 10, 18, 5, 5, 14))}
      </g>
    ));
    s.put(d - ARM / 2, belt([FP(sx + 12, hy, 2), FP(hx - 16, hy, 2)], `in-x${h}`));
    const cy = hy - ARM;
    s.put(d - ARM, (
      <g key={`constructor${h}`}>
        {box(isoBox(FP, hx - 12, cy - 12, 0, 24, 24, 22))}
        {box(isoBox(FP, hx - 8, cy - 8, 22, 16, 16, 3))}
      </g>
    ));
    s.put(d - ARM / 2, belt([FP(hx, cy + 12, 2), FP(hx, hy - 16, 2)], `in-y${h}`));
    s.put(d - 20, (
      <g key={`tanks${h}`}>
        {cylinder(isoCylinder(FP, hx + 36, hy - 48, 8, 20))}
        {cylinder(isoCylinder(FP, hx + 54, hy - 40, 6, 14))}
      </g>
    ));
    if (h < HUBS.length - 1) {
      const [nx, ny] = HUBS[h + 1];
      s.put(d + 50, belt([FP(hx + 16, hy, 2), FP(nx, hy, 2), FP(nx, ny + 16, 2)], `link${h}`));
    } else {
      s.put(d + 60, box(isoBox(FP, hx + 50, hy - 11, 0, 22, 22, 16), 'storage'));
      s.put(d + 40, belt([FP(hx + 16, hy, 2), FP(hx + 50, hy, 2)], 'out'));
    }
  });
  const [mx, my] = [HUBS[0][0], HUBS[0][1] + 62];
  s.put(mx + my, (
    <g key="miner">
      {box(isoBox(FP, mx - 12, my - 12, 0, 24, 24, 12))}
      {box(isoBox(FP, mx - 4, my - 4, 12, 8, 8, 26))}
    </g>
  ));
  s.put(mx + my - 20, belt([FP(mx, my - 12, 2), FP(mx, HUBS[0][1] + 16, 2)], 'ore'));
  return s.draw();
}

const POLES = HUBS.map(([hx, hy]) => ({ foot: FP(hx - 40, hy - 44, 0), top: FP(hx - 40, hy - 44, 46) }));

const factory = (
  <g>
    {floorGrid(FP, 16, 400, 0.22)}
    <g className="cover-art__line">
      {POLES.map((p) => <line key={p.foot[0]} x1={p.foot[0]} y1={p.foot[1]} x2={p.top[0]} y2={p.top[1]} strokeWidth="2" {...HAIR} />)}
      <path
        d={POLES.slice(1).map((p, k) => `M${pt(...POLES[k].top)}Q${pt((POLES[k].top[0] + p.top[0]) / 2, (POLES[k].top[1] + p.top[1]) / 2 + 12)} ${pt(...p.top)}`).join('')}
        strokeWidth="1"
        opacity="0.7"
        {...HAIR}
      />
    </g>
    {factoryParts()}
  </g>
);

/**
 * An asteroid refinery: a chunk of rock floating in space, its top levelled into pads
 * and its broken sides falling away beneath. On it a drilling rig in a lattice derrick, a
 * refinery block with its tanks and radiators, and rows of solar panels; from it a mass
 * driver's rail runs out along -y over the edge, ringed with coils, and flings containers
 * of refined ore up and away. A banded planet and smaller rocks hang behind.
 */
const RP = isoProjector(220, 92);
const OUTLINE = range(18).map((i) => {
  const a = (i / 18) * Math.PI * 2;
  const r = 100 * (0.82 + 0.28 * hash(6000 + i));
  return [r * Math.cos(a), r * Math.sin(a) * 0.9];
});
const RAIL_X = 40;
const RAIL_FROM = -58;
const RAIL_TO = -330;
const RAIL_Z = 10;
const LAUNCH_VECTOR = [RP(RAIL_X, RAIL_TO, RAIL_Z), RP(RAIL_X, RAIL_FROM, RAIL_Z)].reduce((a, b) => [a[0] - b[0], a[1] - b[1]]);

function rockSides() {
  return OUTLINE.map((p, i) => {
    const q = OUTLINE[(i + 1) % OUTLINE.length];
    const [mx, my] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    return { p, q, i, facing: mx + my, right: mx > my };
  })
    .filter((e) => e.facing > 0)
    .sort((a, b) => a.facing - b.facing)
    .map(({ p, q, i, right }) => {
      const depthP = 26 + 18 * hash(6100 + i);
      const depthQ = 26 + 18 * hash(6100 + ((i + 1) % OUTLINE.length));
      return <path key={i} className={`${right ? 'is-full' : 'is-mid'} is-sheet`} d={poly([RP(p[0], p[1], 0), RP(q[0], q[1], 0), RP(q[0] * 0.8, q[1] * 0.8, -depthQ), RP(p[0] * 0.8, p[1] * 0.8, -depthP)])} strokeWidth="0.75" {...HAIR} />;
    });
}

function refineryParts() {
  const s = scene();
  s.put(-60, <path key="rail-pad" className="is-mid" d={poly([RP(RAIL_X - 10, RAIL_FROM - 6, 0), RP(RAIL_X + 10, RAIL_FROM - 6, 0), RP(RAIL_X + 10, RAIL_FROM + 12, 0), RP(RAIL_X - 10, RAIL_FROM + 12, 0)])} />);
  s.put(-40, (
    <g key="rail">
      <g className="cover-art__line">
        {[RAIL_FROM + 8, RAIL_FROM - 22].map((y) => <path key={y} d={`M${pt(...RP(RAIL_X, y, 0))}L${pt(...RP(RAIL_X, y, RAIL_Z))}`} strokeWidth="2" {...HAIR} />)}
        {[-4, 4].map((o) => <path key={o} d={`M${pt(...RP(RAIL_X + o, RAIL_FROM + 8, RAIL_Z))}L${pt(...RP(RAIL_X + o, RAIL_TO, RAIL_Z))}`} strokeWidth="1.5" {...HAIR} />)}
        {range(14).map((i) => <path key={i} d={isoCircle(RP, [RAIL_X, RAIL_FROM - 8 - i * 20, RAIL_Z], 8, 'xz')} strokeWidth="1.25" opacity="0.8" {...HAIR} />)}
      </g>
      {[0, 3, 6].map((t) => (
        <g key={t} className="cover-carry" style={{ '--dx': `${LAUNCH_VECTOR[0].toFixed(1)}px`, '--dy': `${LAUNCH_VECTOR[1].toFixed(1)}px`, animationDuration: '9s', animationDelay: `-${t}s` }}>
          {box(isoBox(RP, RAIL_X - 2.5, RAIL_FROM - 3, RAIL_Z + 1, 5, 6, 4))}
        </g>
      ))}
    </g>
  ));
  s.put(-25, (
    <g key="refinery">
      {box(isoBox(RP, -14, -40, 0, 44, 30, 2))}
      {box(isoBox(RP, -10, -36, 2, 28, 22, 18))}
      {box(isoBox(RP, -6, -32, 20, 10, 10, 10))}
      {box(isoBox(RP, 20, -44, 2, 3, 14, 24))}
      {box(isoBox(RP, 25, -44, 2, 3, 14, 24))}
    </g>
  ));
  s.put(-10, (
    <g key="tanks">
      {cylinder(isoCylinder(RP, 22, -12, 7, 22))}
      {cylinder(isoCylinder(RP, 36, -4, 6, 18))}
    </g>
  ));
  s.put(-100, <g key="panels">{[-58, -44, -30].flatMap((y) => [-66, -42].map((x) => panel(RP, x, y, 22, `${x}${y}`)))}</g>);
  s.put(-20, (
    <g key="rig">
      {box(isoBox(RP, -62, 10, 0, 30, 30, 2))}
      <path className="is-full" d={isoCircle(RP, [-47, 25, 2], 7)} />
      {[[-56, 16], [-38, 16], [-56, 34], [-38, 34]].map(([x, y]) => box(isoBox(RP, x - 2, y - 2, 2, 4, 4, 5), `foot${x}${y}`))}
      {lattice(RP, -47, 25, 9, 66, 'derrick')}
      <g className="cover-art__line"><path d={`M${pt(...RP(-47, 25, 52))}L${pt(...RP(-47, 25, 26))}`} strokeWidth="2.5" {...HAIR} /></g>
      {box(isoBox(RP, -51, 21, 52, 8, 8, 7), 'drill-head')}
      {drillBit(RP, -47, 25, 4, 26)}
      <g className="cover-flicker" style={{ animationDuration: '1.3s' }}>
        <g className="cover-art__fill" opacity="0.6">
          {[[-10, 2], [9, -1], [-4, 5], [6, 4]].map(([dx, dy]) => <circle key={dx} cx={RP(-47, 25, 2)[0] + dx} cy={RP(-47, 25, 2)[1] + dy} r="1.2" />)}
        </g>
      </g>
      <circle className="is-full cover-twinkle" cx={RP(-47, 25, 67)[0]} cy={RP(-47, 25, 67)[1]} r="2.4" />
    </g>
  ));
  return s.draw();
}

const refinery = (
  <g>
    {sky(starfield(3500, 70))}
    <circle className="is-light" cx="560" cy="118" r="88" />
    <g className="cover-art__line" opacity="0.3">
      {[-50, -24, 0, 26, 52].map((dy, i) => {
        const half = Math.sqrt(88 ** 2 - dy ** 2);
        return <line key={dy} x1={560 - half} x2={560 + half} y1={118 + dy} y2={118 + dy} strokeWidth={4 + (i % 2) * 3} {...HAIR} />;
      })}
    </g>
    {[[470, 30, 7, 3510], [380, 130, 5, 3520], [80, 30, 6, 3530], [150, 140, 4, 3540]].map(([x, y, r, seed]) => (
      <path key={seed} className="is-mid" d={poly(rock(x, y, r, seed))} />
    ))}
    <path className="is-light is-sheet" d={poly(OUTLINE.map(([x, y]) => RP(x, y, 0)))} strokeWidth="0.75" {...HAIR} />
    {rockSides()}
    <g className="cover-art__fill" opacity="0.35">
      {[[-20, 50, 12], [60, 20, 9], [-80, -10, 7], [10, 60, 6]].map(([x, y, r]) => <path key={x} className="is-mid" d={isoCircle(RP, [x, y, 0], r)} />)}
    </g>
    {refineryParts()}
  </g>
);

/**
 * A planetary base on the planet itself: its surface runs to a gently curved horizon
 * with a thin glow of atmosphere at the limb, a range of far mountains along it and a
 * banded giant rising behind, craters and boulders strewn over the ground. On it, each
 * on its own foundation: geodesic domes joined by corridors, a landing pad with a lander
 * hovering over it, a factory feeding two silos by belt, solar panels, a lattice comms
 * mast with its dish and beacon, and a rover out on the plain. Every foundation sits
 * forward of the horizon, so the whole base stands on the ground.
 */
const OP = isoProjector(300, 70);
const WORLD = { cy: 1438, r: 1400 };
const horizonY = (x) => WORLD.cy - Math.sqrt(WORLD.r ** 2 - (x - 300) ** 2);

function dome(x, y, r, key) {
  const d = isoDome(OP, x, y, r);
  return (
    <g key={key}>
      <path className="is-full" d={isoCircle(OP, [x, y, 0], r + 3)} />
      <path className="is-light is-sheet" d={d.outline} strokeWidth="1" {...HAIR} />
      <g className="cover-art__line" opacity="0.45">
        <path d={[...d.rings, ...d.meridians].join('')} strokeWidth="1" {...HAIR} />
      </g>
    </g>
  );
}

/** Craters and boulders strewn over the ground; a boulder beyond the horizon would float in the sky, so none is. */
const CRATERS = [[-70, 110, 16], [150, 90, 12], [-10, 110, 9], [60, -70, 10], [-100, 120, 7], [170, 20, 8], [20, 140, 14]];
const BOULDERS = range(24).map((i) => {
  const [x, y] = [-160 + hash(i + 6300) * 340, -40 + hash(i + 6350) * 200];
  return { x, y, r: 2 + hash(i + 6400) * 4, seed: 6450 + i * 7 };
}).filter(({ x, y }) => {
  const [sx, sy] = OP(x, y, 0);
  return sy > horizonY(sx) + 8;
});

function outpostParts() {
  const s = scene();
  s.put(-40, <g key="panels">{[-38, -26].flatMap((y) => [-22, 4].map((x) => panel(OP, x, y, 22, `${x}${y}`)))}</g>);
  s.put(-30, dome(-70, 40, 13, 'dome-c'));
  s.put(-20, (
    <g key="factory">
      {box(isoBox(OP, 28, -62, 0, 54, 36, 2))}
      {box(isoBox(OP, 30, -60, 2, 48, 32, 20))}
      {[34, 46, 58].map((x) => box(isoBox(OP, x, -56, 22, 8, 24, 5), `vent${x}`))}
      {box(isoBox(OP, 70, -58, 22, 5, 5, 18))}
    </g>
  ));
  s.put(-18, dome(-40, 20, 24, 'dome-a'));
  s.put(20, box(isoBox(OP, -18, 16, 0, 16, 8, 6), 'corridor-x'));
  s.put(40, box(isoBox(OP, -4, 20, 0, 8, 20, 6), 'corridor-y'));
  s.put(35, belt([OP(78, -40, 4), OP(92, -40, 4)], 'silo-belt'));
  s.put(62, (
    <g key="silos">
      {box(isoBox(OP, 90, -50, 0, 22, 34, 2))}
      {cylinder(isoCylinder(OP, 100, -42, 8, 30, 2))}
      {cylinder(isoCylinder(OP, 100, -24, 8, 26, 2))}
    </g>
  ));
  s.put(50, dome(0, 50, 14, 'dome-b'));
  s.put(110, (
    <g key="pad">
      {box(isoBox(OP, 30, 40, 0, 48, 48, 2))}
      <g className="cover-art__rule"><path d={isoCircle(OP, [54, 64, 2], 16)} strokeWidth="1.25" {...HAIR} /></g>
      <g className="cover-art__ground">
        {[[32, 42], [76, 42], [76, 86], [32, 86]].map(([x, y], i) => {
          const [px, py] = OP(x, y, 2);
          return <circle key={i} className="cover-twinkle" style={{ animationDuration: '2s', animationDelay: `-${i * 0.5}s` }} cx={px} cy={py} r="1.3" />;
        })}
      </g>
    </g>
  ));
  s.put(125, (
    <g key="lander" className="cover-hover" style={{ '--hover': '4px', animationDuration: '5s' }}>
      <g className="cover-art__line">
        <path d={[[-7, -7], [7, -7], [7, 7], [-7, 7]].map(([dx, dy]) => `M${pt(...OP(54 + dx * 0.6, 64 + dy * 0.6, 26))}L${pt(...OP(54 + dx, 64 + dy, 16))}`).join('')} strokeWidth="1.25" {...HAIR} />
      </g>
      {box(isoBox(OP, 48, 58, 24, 12, 12, 9))}
      {box(isoBox(OP, 51, 61, 33, 6, 6, 4))}
    </g>
  ));
  s.put(130, (
    <g key="mast">
      {box(isoBox(OP, 102, 12, 0, 16, 16, 2))}
      {lattice(OP, 110, 20, 6, 66, 'mast-lattice')}
      <g className="cover-art__line">
        <path d={isoCircle(OP, [114, 20, 58], 7, 'xz')} strokeWidth="1.5" {...HAIR} />
      </g>
      <circle className="is-full cover-twinkle" style={{ animationDuration: '1.6s' }} cx={OP(110, 20, 68)[0]} cy={OP(110, 20, 68)[1]} r="2.4" />
    </g>
  ));
  s.put(50, (
    <g key="rover">
      {box(isoBox(OP, -48, 84, 3, 18, 10, 6))}
      {box(isoBox(OP, -44, 86, 9, 8, 6, 4))}
      <g className="cover-art__fill">
        {[[-46, 94], [-34, 94]].map(([x, y]) => <path key={x} d={isoCircle(OP, [x, y, 3], 3, 'xz')} />)}
      </g>
    </g>
  ));
  return s.draw();
}

const outpost = (
  <g>
    {sky(starfield(3700, 60, 0, 60))}
    <circle className="is-light" cx="520" cy="22" r="54" />
    <g className="cover-art__line" opacity="0.3">
      {[-30, -10, 10, 30].map((dy, i) => {
        const half = Math.sqrt(54 ** 2 - dy ** 2);
        return <line key={dy} x1={520 - half} x2={520 + half} y1={22 + dy} y2={22 + dy} strokeWidth={3 + (i % 2) * 3} {...HAIR} />;
      })}
    </g>
    <path className="is-mid" d={`M0 ${horizonY(0) + 2}${range(63).map((i) => { const x = i * 10; return `L${pt(x, horizonY(x) - 3 - 9 * Math.abs(Math.sin(x / 37)) * hash(i + 6500))}`; }).join('')}L${W} ${horizonY(W) + 2}Z`} opacity="0.55" />
    <circle className="is-light" cx="300" cy={WORLD.cy} r={WORLD.r} />
    <g className="cover-art__line">
      <circle cx="300" cy={WORLD.cy} r={WORLD.r + 3} strokeWidth="3" opacity="0.25" {...HAIR} />
    </g>
    {CRATERS.map(([x, y, r]) => (
      <g key={`${x}-${y}`}>
        <path className="is-mid" d={isoCircle(OP, [x, y, 0], r)} opacity="0.3" />
        <g className="cover-art__line" opacity="0.4"><path d={isoCircle(OP, [x, y, 0], r)} strokeWidth="1" {...HAIR} /></g>
      </g>
    ))}
    {BOULDERS.map((b) => {
      const [x, y] = OP(b.x, b.y, 0);
      return <path key={b.seed} className="is-mid" d={poly(rock(x, y - b.r * 0.4, b.r, b.seed, 8))} />;
    })}
    {outpostParts()}
  </g>
);

/**
 * A maglev launch assist: a guideway run straight up a stepped mountain of terraces on
 * pylons, ringed with coils, from a launch hall at its foot to the summit, and a
 * spaceplane on it. The plane, the guideway and the coils come from one projection, so
 * the plane rides the rail exactly. When covers move, it gathers speed up the guideway
 * (CSS's ease-in) and flies off the summit, and each coil flashes as it passes: its delay
 * is when ease-in brings the plane to it (`easeInReaches`).
 */
const MP = isoProjector(310, 265);
const START = -260;
const END = 260;
const SLOPE = 0.62;
const trackZ = (x) => 10 + (x - START) * SLOPE;

/** The launch loop in seconds, and the share of it the run up the guideway takes (as CoverArt.css). */
const LAUNCH = 10;
const RUN = 0.62;

/** When, as a share of the run, CSS's ease-in (cubic-bezier(0.42, 0, 1, 1)) reaches a share `s` of the way. */
function easeInReaches(s) {
  const bezier = (a, b, t) => 3 * a * (1 - t) ** 2 * t + 3 * b * (1 - t) * t * t + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (bezier(0, 1, mid) < s) lo = mid;
    else hi = mid;
  }
  return bezier(0.42, 1, lo);
}

const TERRACES = range(15).map((i) => {
  const x0 = -300 + i * 40;
  const top = x0 < END ? Math.max(4, trackZ(x0) - 12) : trackZ(END) - 12 - (x0 - END + 40) * 1.2;
  return { x0, top };
});
const LENGTH = Math.hypot(END - START, (END - START) * SLOPE);
const ALONG = [(END - START) / LENGTH, 0, ((END - START) * SLOPE) / LENGTH];
const UP = [-ALONG[2], 0, ALONG[0]];
const scaled = (v, k) => v.map((c) => c * k);
const PLANE_AT = [START, -4, trackZ(START) + 3];
const RIDE = [MP(END, 0, trackZ(END)), MP(START, 0, trackZ(START))].reduce((a, b) => [a[0] - b[0], a[1] - b[1]]);

/** A coil round the guideway at world point `c`: a circle in the plane square to the slope, across (y) and UP. */
function ringAround(c, r) {
  return poly(range(28).map((i) => {
    const t = (i / 28) * Math.PI * 2;
    return MP(...[0, 1, 2].map((k) => c[k] + (k === 1 ? r * Math.cos(t) : 0) + r * Math.sin(t) * UP[k]));
  }));
}

/** A point on the spaceplane: `a` along it from the tail, `b` across (0 its right side, 8 its left), `c` up from the belly. */
const onPlane = (a, b, c) => MP(...PLANE_AT.map((p, i) => p + ALONG[i] * a + (i === 1 ? b : 0) + UP[i] * c));

/**
 * The spaceplane: a fuselage with a pointed nose, delta wings (the far one behind the
 * body), a tail fin and a dark canopy, all laid along the slope of the guideway.
 */
function spaceplane() {
  const face = (tone, pts, key) => <path key={key} className={`${tone} is-sheet`} d={poly(pts.map((p) => onPlane(...p)))} strokeWidth="0.75" {...HAIR} />;
  return (
    <>
      {face('is-full', [[7, 0, 2], [21, 0, 2], [5, -13, 2]], 'wing-far')}
      {box(isoSlab(MP, PLANE_AT, scaled(ALONG, 26), [0, 8, 0], scaled(UP, 4.5)), 'fuselage')}
      {face('is-mid', [[26, 8, 0], [26, 8, 4.5], [38, 4, 2.2]], 'nose-side')}
      {face('is-light', [[26, 0, 4.5], [26, 8, 4.5], [38, 4, 2.2]], 'nose-top')}
      {face('is-full', [[17, 2, 4.5], [24, 2.5, 4.5], [24, 5.5, 4.5], [17, 6, 4.5]], 'canopy')}
      {face('is-mid', [[7, 8, 2], [21, 8, 2], [5, 21, 2]], 'wing-near')}
      {face('is-light', [[0, 4, 4.5], [8, 4, 4.5], [0, 4, 13]], 'fin')}
    </>
  );
}

const maglev = (
  <g>
    {sky(starfield(3900, 80, 0, 110))}
    <circle className="is-light" cx="120" cy="30" r="11" />
    <circle className="is-ground" cx="125" cy="26" r="10" />
    <path className="is-light" d={`M0 150${range(32).map((i) => `L${pt(i * 20, 96 - 34 * Math.exp(-(((i * 20 - 200) / 150) ** 2)) - 6 * Math.sin(i * 1.3))}`).join('')}L${W} 150Z`} opacity="0.45" />
    {TERRACES.map(({ x0, top }) => box(isoBox(MP, x0, -70, 0, 40, 120, top), `t${x0}`))}
    {box(isoBox(MP, START - 50, -30, 0, 44, 50, trackZ(START) + 16), 'hall')}
    {box(isoBox(MP, START - 40, -20, trackZ(START) + 16, 16, 16, 10), 'hall-top')}
    <g className="cover-art__line">
      {TERRACES.filter(({ x0 }) => x0 >= START && x0 + 20 <= END).map(({ x0, top }) => {
        const x = x0 + 20;
        return <path key={x} d={`M${pt(...MP(x, 0, top))}L${pt(...MP(x, 0, trackZ(x) - 3))}`} strokeWidth="2.5" {...HAIR} />;
      })}
    </g>
    {box(isoSlab(MP, [START, -5, trackZ(START) - 3], [END - START, 0, (END - START) * SLOPE], [0, 10, 0], [0, 0, 3]), 'guideway')}
    <g className="cover-art__line">
      <path d={[-3, 3].map((o) => `M${pt(...MP(START, o, trackZ(START)))}L${pt(...MP(END, o, trackZ(END)))}`).join('')} strokeWidth="1" opacity="0.8" {...HAIR} />
      <path d={`M${pt(...MP(END, 0, trackZ(END)))}L${pt(...MP(END + 90, 0, trackZ(END + 90) + 20))}`} strokeWidth="1" strokeDasharray="2 4" opacity="0.5" {...HAIR} />
    </g>
    {range(17).map((i) => {
      const s = (i + 0.5) / 17;
      const x = START + s * (END - START);
      return (
        <g key={i} className="cover-art__line">
          <path className="maglev-coil" style={{ animationDelay: `${((RUN * easeInReaches(s) - 1) * LAUNCH).toFixed(2)}s` }} d={ringAround([x, 0, trackZ(x) + 2], 9)} strokeWidth="1.5" opacity="0.7" {...HAIR} />
        </g>
      );
    })}
    <g className="maglev-run" style={{ '--dx': `${RIDE[0].toFixed(1)}px`, '--dy': `${RIDE[1].toFixed(1)}px` }}>
      {spaceplane()}
    </g>
  </g>
);

/** The isometric space covers, by id. */
export const SPACE_ISO_ART = { factory, refinery, outpost, maglev };
