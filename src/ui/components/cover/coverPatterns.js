/**
 * The drawn covers' names and the order the Change cover menu offers them in, by
 * section. The drawings themselves are CoverArt's; the ids are shared/covers.js's.
 */

/** The Change cover menu's sections, in order. */
export const COVER_GROUPS = [
  { id: 'study', patterns: ['cards', 'notes', 'stack', 'leitner', 'shelf', 'stars'] },
  { id: 'mathematics', patterns: ['euclid', 'golden', 'sierpinski', 'harmonograph', 'stella'] },
  { id: 'sciences', patterns: ['periodic', 'helix', 'waves', 'lattice', 'atom'] },
  { id: 'nature', patterns: ['botanical', 'tree', 'sunflower', 'graticule', 'scan', 'aurora'] },
  { id: 'humanities', patterns: ['colonnade', 'music', 'orrery', 'giza', 'aztec'] },
  { id: 'paper', patterns: ['ruled', 'graph', 'contours', 'halftone', 'mosaic', 'stripes', 'arcs'] },
];

/** A menu section's heading. */
export function coverGroupLabel(id, t) {
  const labels = {
    study: t('Study desk'),
    mathematics: t('Mathematics'),
    sciences: t('Sciences'),
    nature: t('Life and earth'),
    humanities: t('Humanities'),
    paper: t('Patterns'),
  };
  return labels[id] ?? id;
}

/** A drawn cover's name. */
export function coverPatternLabel(id, t) {
  const labels = {
    cards: t('Scattered cards'),
    arcs: t('Rings'),
    notes: t('Pile of notes'),
    stack: t('Card stack'),
    leitner: t('Leitner boxes'),
    shelf: t('Bookshelf'),
    stars: t('Constellation'),
    ruled: t('Ruled paper'),
    graph: t('Graph paper'),
    contours: t('Contours'),
    halftone: t('Halftone'),
    mosaic: t('Mosaic'),
    stripes: t('Stripes'),
    euclid: t('Euclid’s construction'),
    golden: t('Golden spiral'),
    sierpinski: t('Sierpiński triangle'),
    harmonograph: t('Harmonograph'),
    stella: t('Stella octangula'),
    periodic: t('Periodic table'),
    helix: t('Double helix'),
    waves: t('Wave interference'),
    lattice: t('Crystal lattice'),
    atom: t('Atom'),
    botanical: t('Botanical plate'),
    tree: t('Tree of life'),
    sunflower: t('Sunflower'),
    graticule: t('Graticule'),
    scan: t('Terrain scan'),
    aurora: t('Aurora borealis'),
    colonnade: t('Colonnade'),
    music: t('Sheet music'),
    orrery: t('Orrery'),
    giza: t('Egyptian pyramids'),
    aztec: t('Aztec pyramid'),
  };
  return labels[id] ?? id;
}
