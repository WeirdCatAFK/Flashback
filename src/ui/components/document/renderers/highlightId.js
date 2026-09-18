/**
 * Highlight ids: `h_` plus nine base-36 characters from 64 random bits — short
 * enough to live in a sidecar, random enough that two documents never collide.
 * One minter for every renderer.
 */

export function generateHighlightId() {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return 'h_' + (rand[0].toString(36) + rand[1].toString(36)).slice(0, 9);
}
