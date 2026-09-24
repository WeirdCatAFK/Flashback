/**
 * The arithmetic behind a deck cover's Reposition: where the image sits in its
 * banner is one number, `y` in 0..1 — CSS `object-position: 50% <y*100>%` — and a
 * drag moves it by the distance dragged over the distance the image can travel.
 * No React, no DOM.
 */

/**
 * How far, in px, an image cropped to fill a banner can slide vertically: its
 * height at the banner's width, less the banner's height. 0 when it cannot move.
 */
export function coverTravel(naturalW, naturalH, bannerW, bannerH) {
  if (!naturalW || !naturalH || !bannerW) return 0;
  return Math.max(0, (naturalH * bannerW) / naturalW - bannerH);
}

/**
 * The position after dragging `dy` px (down is positive) from `startY`. Dragging
 * down pulls the image down, which shows more of its top — so `y` falls.
 */
export function dragCoverY(startY, dy, travel) {
  if (travel <= 0) return startY;
  return Math.min(1, Math.max(0, startY - dy / travel));
}
