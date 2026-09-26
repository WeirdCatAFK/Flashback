/**
 * The d3-force tuning: short-range repulsion so communities can form, collide as
 * the no-overlap floor, learned edges that contract, and a gentle pull to the
 * centre that strengthens with learning. Overriding link strength discards d3's
 * 1/min(degree) heuristic, so degree is recomputed here and folded back in.
 */

import { forceCollide, forceX, forceY } from 'd3-force';
import { collideRadius } from '../graphMetrics.js';
import { learnedOf, nodeId } from './graphData.js';
import { NODE_R } from './paint.js';

/** Degree of every node over `links`. */
export function degreeMap(links) {
  const deg = new Map();
  for (const l of links) {
    const s = nodeId(l.source), t = nodeId(l.target);
    deg.set(s, (deg.get(s) ?? 0) + 1);
    deg.set(t, (deg.get(t) ?? 0) + 1);
  }
  return deg;
}

/** Charge strength and reach for a cohesion in 0..1. */
export const chargeFor = (cohesion) => ({
  strength: -(45 + 235 * (1 - cohesion)),
  distanceMax: 130 + 370 * (1 - cohesion),
});

/** Apply the tuning to a react-force-graph instance and reheat it. */
export function applyForces(fg, visibleData, cohesion) {
  const minLearn = (l) => Math.min(learnedOf(l.source), learnedOf(l.target));
  const charge = chargeFor(cohesion);
  fg.d3Force('charge').strength(charge.strength).distanceMax(charge.distanceMax);

  const deg = degreeMap(visibleData.links);
  fg.d3Force('link')
    .distance((l) => 70 - 34 * minLearn(l))
    .strength((l) => {
      const base = 1 / Math.max(1, Math.min(deg.get(nodeId(l.source)) ?? 1, deg.get(nodeId(l.target)) ?? 1));
      return base * (1 + 0.8 * minLearn(l));
    });

  fg.d3Force('collide', forceCollide((node) => collideRadius(node, NODE_R)));
  fg.d3Force('x', forceX(0).strength((n) => 0.015 + 0.05 * learnedOf(n)));
  fg.d3Force('y', forceY(0).strength((n) => 0.015 + 0.05 * learnedOf(n)));
  fg.d3ReheatSimulation();
}
