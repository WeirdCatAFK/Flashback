export const COVER_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

export const COVER_PATTERNS = ['cards', 'arcs', 'notes', 'stack', 'leitner', 'shelf', 'stars', 'ruled', 'graph', 'contours', 'halftone', 'mosaic', 'stripes',
  'euclid', 'golden', 'sierpinski', 'harmonograph', 'stella', 'periodic', 'helix', 'waves', 'lattice', 'atom',
  'botanical', 'tree', 'sunflower', 'graticule', 'scan', 'aurora', 'colonnade', 'music', 'orrery', 'giza', 'aztec',
  'elevator', 'factory', 'shipyard', 'refinery', 'outpost', 'maglev', 'station', 'asteroids', 'earthrise', 'ringed', 'blackhole', 'telescope'];

export const MAX_COVER_BYTES = 10 * 1024 * 1024;

const COVER_NAME = /^[A-Za-z0-9-]+\.(png|jpg|webp|gif|avif)$/;

export function coverMime(file) {
  const ext = String(file).split('.').pop();
  return Object.entries(COVER_TYPES).find(([, e]) => e === ext)?.[0] ?? null;
}

export function cleanCover(cover) {
  if (cover?.kind === 'pattern' && COVER_PATTERNS.includes(cover.pattern)) return { kind: 'pattern', pattern: cover.pattern };
  if (cover?.kind === 'image' && COVER_NAME.test(cover.file ?? '')) {
    const y = Number.isFinite(cover.y) ? Math.min(1, Math.max(0, cover.y)) : 0.5;
    return { kind: 'image', file: cover.file, y };
  }
  return null;
}

export const clampCoverY = (y) => Math.min(1, Math.max(0, Number(y) || 0));
