/**
 * What every drawn cover is made with: the 620×150 box, the fixed hash that stands in
 * for randomness (so a cover looks the same every time), and the shared bits of style.
 * No React, no DOM.
 */

/** The box every drawing is made in; it is cropped to fill, never stretched. */
export const W = 620;
export const H = 150;

/** A stable 0..1 from an integer: the "random" in every scatter. */
export function hash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** 0, 1, … n-1. */
export const range = (n) => Array.from({ length: n }, (_, i) => i);

/** A thin rule keeps its width in px however far the drawing is scaled. */
export const HAIR = { vectorEffect: 'non-scaling-stroke' };

/** The three fill steps, strongest first. */
export const TONES = ['is-full', 'is-mid', 'is-light'];
