export function coverTravel(naturalW, naturalH, bannerW, bannerH) {
  if (!naturalW || !naturalH || !bannerW) return 0;
  return Math.max(0, (naturalH * bannerW) / naturalW - bannerH);
}

export function dragCoverY(startY, dy, travel) {
  if (travel <= 0) return startY;
  return Math.min(1, Math.max(0, startY - dy / travel));
}
