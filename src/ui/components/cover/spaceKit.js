import { W, hash, range } from './artKit.js';

export const pt = (x, y) => `${x.toFixed(1)} ${y.toFixed(1)}`;

export const poly = (points) => `M${points.map(([x, y]) => pt(x, y)).join('L')}Z`;

export const polyline = (points) => `M${points.map(([x, y]) => pt(x, y)).join('L')}`;

export function starfield(seed, count, top = 0, bottom = 150) {
  return range(count).map((i) => ({
    x: hash(seed + i * 3) * W,
    y: top + hash(seed + i * 3 + 1) * (bottom - top),
    r: 0.4 + hash(seed + i * 3 + 2) ** 3 * 1.6,
  }));
}

export function isoProjector(ox, oy) {
  const c = Math.cos(Math.PI / 6);
  return (x, y, z = 0) => [ox + (x - y) * c, oy + (x + y) * 0.5 - z];
}

export function isoBox(P, x, y, z, w, d, h) {
  return {
    top: poly([P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)]),
    left: poly([P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)]),
    right: poly([P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)]),
  };
}

export function isoCylinder(P, x, y, r, h, z = 0) {
  const [cx, bottom] = P(x, y, z);
  const top = bottom - h;
  const rx = r * 1.22;
  const ry = r * 0.7;
  return {
    side: `M${pt(cx - rx, top)}V${bottom.toFixed(1)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 0 0 ${pt(cx + rx, bottom)}V${top.toFixed(1)}Z`,
    shade: `M${pt(cx + rx * 0.3, top + ry * 0.95)}V${(bottom + ry * 0.95).toFixed(1)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 0 0 ${pt(cx + rx, bottom)}V${top.toFixed(1)}Z`,
    cap: { cx, cy: top, rx, ry },
  };
}

export function rock(cx, cy, r, seed, corners = 11) {
  return range(corners).map((i) => {
    const a = (i / corners) * Math.PI * 2;
    const rr = r * (0.75 + 0.3 * hash(seed + i));
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a) * 0.85];
  });
}

export function ellipseHalves(rx, ry) {
  return {
    back: `M${pt(-rx, 0)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 0 1 ${pt(rx, 0)}`,
    front: `M${pt(rx, 0)}A${rx.toFixed(1)} ${ry.toFixed(1)} 0 0 1 ${pt(-rx, 0)}`,
  };
}

export function isoSlab(P, o, a, b, c) {
  const at = (...vs) => P(...[0, 1, 2].map((i) => o[i] + vs.reduce((s, v) => s + v[i], 0)));
  return {
    top: poly([at(c), at(c, a), at(c, a, b), at(c, b)]),
    left: poly([at(b), at(b, a), at(b, a, c), at(b, c)]),
    right: poly([at(a), at(a, b), at(a, b, c), at(a, c)]),
  };
}

export function isoCircle(P, c, r, plane = 'xy', steps = 28) {
  return poly(range(steps).map((i) => {
    const a = (i / steps) * Math.PI * 2;
    const [u, v] = [r * Math.cos(a), r * Math.sin(a)];
    const d = plane === 'xy' ? [u, v, 0] : plane === 'yz' ? [0, u, v] : [u, 0, v];
    return P(c[0] + d[0], c[1] + d[1], c[2] + d[2]);
  }));
}

export function isoDome(P, x, y, r) {
  const [cx, cy] = P(x, y, 0);
  const R = r * 1.2247;
  const foot = r * 0.7071;
  const rings = [0.35, 0.7].map((f) => {
    const rho = Math.sqrt(1 - f * f) * r;
    const [rx, ry] = P(x, y, f * r);
    return `M${pt(rx - rho * 1.2247, ry)}A${(rho * 1.2247).toFixed(1)} ${(rho * 0.7071).toFixed(1)} 0 0 0 ${pt(rx + rho * 1.2247, ry)}`;
  });
  const meridians = range(7).map((k) => {
    const phi = ((-45 + k * 30) * Math.PI) / 180;
    return polyline(range(9).map((j) => {
      const th = (j / 8) * (Math.PI / 2);
      return P(x + r * Math.cos(th) * Math.cos(phi), y + r * Math.cos(th) * Math.sin(phi), r * Math.sin(th));
    }));
  });
  return {
    outline: `M${pt(cx - R, cy)}A${R.toFixed(1)} ${R.toFixed(1)} 0 0 1 ${pt(cx + R, cy)}A${R.toFixed(1)} ${foot.toFixed(1)} 0 0 1 ${pt(cx - R, cy)}Z`,
    rings,
    meridians,
  };
}
