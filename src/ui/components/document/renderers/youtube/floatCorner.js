export const CORNERS = ['tl', 'tr', 'bl', 'br'];
export const DEFAULT_CORNER = 'bl';

export const storedCorner = (raw) => (CORNERS.includes(raw) ? raw : DEFAULT_CORNER);

export function nearestCorner(x, y, area) {
  const v = y < area.top + area.height / 2 ? 't' : 'b';
  const h = x < area.left + area.width / 2 ? 'l' : 'r';
  return `${v}${h}`;
}

export function cornerPosition(corner, area, width, height, { edge = 16, top = 56 } = {}) {
  const left = corner[1] === 'l' ? area.left + edge : area.left + area.width - edge - width;
  const y = corner[0] === 't' ? area.top + top : area.top + area.height - edge - height;
  return {
    left: Math.max(area.left, left),
    top: Math.max(area.top, y),
  };
}
