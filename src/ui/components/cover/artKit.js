export const W = 620;
export const H = 150;

export function hash(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export const range = (n) => Array.from({ length: n }, (_, i) => i);

export const HAIR = { vectorEffect: 'non-scaling-stroke' };

export const TONES = ['is-full', 'is-mid', 'is-light'];
