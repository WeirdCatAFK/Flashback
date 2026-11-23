import { W, H, range, HAIR } from './artKit.js';
import StellaOctangula from './StellaOctangula.jsx';

const pt = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;

const EUCLID = [[275, 70, true], [44, 36, false], [540, 36, false]].map(([ax, r, main]) => ({
  ax,
  bx: ax + r,
  cx: ax + r / 2,
  cy: 108 - (r * Math.sqrt(3)) / 2,
  r,
  main,
}));

const euclid = (
  <g>
    <g className="cover-art__line">
      <line x1="0" x2={W} y1="108" y2="108" strokeWidth="1" opacity="0.4" {...HAIR} />
      {EUCLID.map((f) => (
        <g key={f.ax} opacity={f.main ? 1 : 0.55}>
          <circle className={f.main ? 'euclid-a' : undefined} cx={f.ax} cy="108" r={f.r} pathLength="1" strokeWidth="1.25" {...HAIR} />
          <circle className={f.main ? 'euclid-b' : undefined} cx={f.bx} cy="108" r={f.r} pathLength="1" strokeWidth="1.25" {...HAIR} />
          <path className={f.main ? 'is-light euclid-c' : 'is-light'} d={`M${f.ax} 108L${f.bx} 108L${pt(f.cx, f.cy)}Z`} pathLength="1" fillOpacity="0.6" strokeWidth="2" strokeLinejoin="round" {...HAIR} />
        </g>
      ))}
    </g>
    <g className="cover-art__fill">
      {EUCLID.flatMap((f) => [[f.ax, 108], [f.bx, 108], [f.cx, f.cy]].map(([x, y]) => (
        <circle key={`${x}-${y}`} className={f.main && y !== 108 ? 'euclid-p' : undefined} cx={x} cy={y} r={f.main ? 3.5 : 2.5} />
      )))}
    </g>
  </g>
);

function goldenSpiral(x, y, w, h, n) {
  const squares = [];
  let d = `M${pt(x, y + h)}`;
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? w : h;
    const arc = `A${side.toFixed(1)} ${side.toFixed(1)} 0 0 1 `;
    if (i % 4 === 0) {
      squares.push([x, y, side]);
      d += arc + pt(x + side, y);
      x += side;
      w -= side;
    } else if (i % 4 === 1) {
      squares.push([x, y, side]);
      d += arc + pt(x + side, y + side);
      y += side;
      h -= side;
    } else if (i % 4 === 2) {
      squares.push([x + w - side, y, side]);
      d += arc + pt(x + w - side, y + side);
      w -= side;
    } else {
      squares.push([x, y + h - side, side]);
      d += arc + pt(x, y + h - side);
      h -= side;
    }
  }
  return { squares, d };
}

const GOLDEN = goldenSpiral(180.5, -5, 258.9, 160, 12);
const GOLDEN_SIDE = goldenSpiral(14, 25, 161.8, 100, 10);

function spiral({ squares, d }, weight, pen) {
  return (
    <>
      {squares.map(([x, y, s], i) => (
        <rect key={i} className="is-light" x={x} y={y} width={s} height={s} fillOpacity={0.12 + (i % 4) * 0.08} strokeWidth="1" opacity="0.8" {...HAIR} />
      ))}
      <path className={pen} d={d} pathLength="1" strokeWidth={weight} strokeLinecap="round" {...HAIR} />
    </>
  );
}

const golden = (
  <g className="cover-art__line">
    <g opacity="0.55">{spiral(GOLDEN_SIDE, 2, 'cover-art__pen cover-art__pen--late')}</g>
    <g opacity="0.55" transform={`translate(${W} 0) scale(-1 1)`}>{spiral(GOLDEN_SIDE, 2, 'cover-art__pen cover-art__pen--later')}</g>
    {spiral(GOLDEN, 2.75, 'cover-art__pen')}
  </g>
);

function sierpinski(x, y, s, up, depth, out) {
  const rise = ((up ? -1 : 1) * s * Math.sqrt(3)) / 2;
  if (depth === 0) {
    out.push(`M${pt(x, y)}L${pt(x + s, y)}L${pt(x + s / 2, y + rise)}Z`);
    return out;
  }
  const half = s / 2;
  sierpinski(x, y, half, up, depth - 1, out);
  sierpinski(x + half, y, half, up, depth - 1, out);
  sierpinski(x + half / 2, y + rise / 2, half, up, depth - 1, out);
  return out;
}

const SIDE = 157;
const TOP = 143 - (SIDE * Math.sqrt(3)) / 2;

const triangles = (
  <g className="cover-art__fill">
    <path className="is-light" d={range(5).flatMap((k) => sierpinski(-60 + SIDE / 2 + k * SIDE, TOP, SIDE, false, 3, [])).join('')} />
    <path className="is-full" d={range(5).flatMap((k) => sierpinski(-60 + k * SIDE, 143, SIDE, true, 4, [])).join('')} opacity="0.85" />
  </g>
);

function harmonograph() {
  const pts = [];
  for (let t = 0; t < 140; t += 0.05) {
    const k = Math.exp(-0.011 * t);
    const x = W / 2 + k * (150 * Math.sin(2 * t + 0.3) + 115 * Math.sin(3.003 * t + 1.1));
    const y = H / 2 + k * (40 * Math.sin(3.011 * t) + 26 * Math.sin(2.002 * t + 0.8));
    pts.push(pt(x, y));
  }
  return `M${pts.join('L')}`;
}

const pendulum = (
  <g className="cover-art__line">
    <path className="cover-art__pen cover-art__pen--slow" d={harmonograph()} pathLength="1" strokeWidth="1" opacity="0.75" {...HAIR} />
  </g>
);

export const MATH_ART = {
  euclid,
  golden,
  sierpinski: triangles,
  harmonograph: pendulum,
  stella: <StellaOctangula />,
};
