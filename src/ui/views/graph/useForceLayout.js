/**
 * Re-applies the force tuning whenever the visible graph or the cohesion knob changes.
 */

import { useEffect } from 'react';
import { applyForces } from './forces.js';

export default function useForceLayout(fgRef, visibleData, cohesion) {
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !visibleData) return;
    applyForces(fg, visibleData, cohesion);
  }, [fgRef, visibleData, cohesion]);
}
