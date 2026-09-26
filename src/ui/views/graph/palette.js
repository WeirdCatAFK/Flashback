/**
 * The graph's colours, read live from the theme's CSS custom properties. Read
 * once per theme change (see useThemeVersion), never per frame.
 */

export function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function readGraphPalette() {
  return {
    nodes: {
      Document: getCSSVar('--color-graph-document'),
      Folder: getCSSVar('--color-graph-folder'),
      Flashcard: getCSSVar('--color-graph-flashcard'),
      Tag: getCSSVar('--color-graph-tag'),
      Deck: getCSSVar('--color-graph-deck'),
    },
    links: {
      connection: getCSSVar('--color-graph-folder'),
      disconnection: getCSSVar('--color-graph-disconnect'),
      inheritance: getCSSVar('--color-graph-inherit'),
      tag: getCSSVar('--color-graph-tag'),
      reference: getCSSVar('--color-graph-flashcard'),
      deck: getCSSVar('--color-graph-deck'),
      link: getCSSVar('--color-graph-link'),
    },
    edge: getCSSVar('--color-graph-edge'),
    bg: getCSSVar('--color-bg-base'),
    label: getCSSVar('--color-fg-secondary'),
  };
}
