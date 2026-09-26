/**
 * Stella octangula — two tetrahedra through each other, the eight-pointed star Kepler
 * named, turning slowly. The largest takes a minute and a half to turn once. The paths
 * are rewritten about twenty times a second straight into the DOM, with no React render
 * per frame, and only while covers may move (coverMotion.js): switched off, the loop
 * stops and the star holds its angle; a thumbnail (`.is-still`) or reduced motion never
 * starts it.
 */

import { useEffect, useRef } from 'react';
import { HAIR } from './artKit.js';
import { coverMotionOn, onCoverMotionChange } from '../../coverMotion.js';

/** Alternate corners of a cube: one tetrahedron; the other is its mirror through the centre. */
const TETRA_A = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
const TETRA_B = TETRA_A.map((v) => v.map((c) => -c));
const FACES = [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]];
const EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

/** How far the turning axis leans toward the viewer, in radians. */
const TILT = 0.42;

/** The stars on the banner: centre, half the cube's side, turns per second (sign is direction), starting angle. */
const STARS = [
  { x: 310, y: 75, s: 40, speed: 1 / 90, phase: 0.5 },
  { x: 108, y: 84, s: 17, speed: -1 / 70, phase: 1.9 },
  { x: 512, y: 66, s: 23, speed: 1 / 110, phase: 3.1 },
];

const FRAME_MS = 50;

/** A corner turned about the vertical axis, leaned by TILT, then flattened onto the banner. */
function project([x, y, z], star, angle) {
  const x1 = x * Math.cos(angle) + z * Math.sin(angle);
  const z1 = -x * Math.sin(angle) + z * Math.cos(angle);
  const y1 = y * Math.cos(TILT) - z1 * Math.sin(TILT);
  return [star.x + x1 * star.s, star.y + y1 * star.s];
}

/** A star's nine paths `seconds` in: the four faces of each tetrahedron, then all twelve edges. */
function starPaths(star, seconds) {
  const angle = star.phase + seconds * star.speed * Math.PI * 2;
  const pt = ([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`;
  const [a, b] = [TETRA_A, TETRA_B].map((t) => t.map((v) => project(v, star, angle)));
  const faces = [a, b].flatMap((p) => FACES.map((f) => `M${f.map((i) => pt(p[i])).join('L')}Z`));
  const edges = [a, b].flatMap((p) => EDGES.map(([i, j]) => `M${pt(p[i])}L${pt(p[j])}`)).join('');
  return [...faces, edges];
}

export default function StellaOctangula() {
  const ref = useRef(null);

  useEffect(() => {
    const root = ref.current;
    if (!root || root.closest('.is-still') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const paths = root.querySelectorAll('path');
    let seconds = 0;
    let frame = 0;
    let last = null;
    const tick = (now) => {
      frame = requestAnimationFrame(tick);
      if (last !== null && now - last < FRAME_MS) return;
      seconds += last === null ? 0 : Math.min(now - last, 200) / 1000;
      last = now;
      STARS.forEach((star, i) => {
        starPaths(star, seconds).forEach((d, j) => paths[i * 9 + j]?.setAttribute('d', d));
      });
    };
    const run = (on) => {
      cancelAnimationFrame(frame);
      last = null;
      if (on) frame = requestAnimationFrame(tick);
    };
    run(coverMotionOn());
    const unsubscribe = onCoverMotionChange(run);
    return () => {
      unsubscribe();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <g ref={ref}>
      {STARS.map((star) => {
        const d = starPaths(star, 0);
        return (
          <g key={star.x}>
            {d.slice(0, 4).map((f, i) => <path key={`a${i}`} className="is-mid" d={f} fillOpacity="0.28" />)}
            {d.slice(4, 8).map((f, i) => <path key={`b${i}`} className="is-light" d={f} fillOpacity="0.42" />)}
            <g className="cover-art__line">
              <path d={d[8]} strokeWidth={star.s > 30 ? 1.75 : 1.25} strokeLinejoin="round" {...HAIR} />
            </g>
          </g>
        );
      })}
    </g>
  );
}
