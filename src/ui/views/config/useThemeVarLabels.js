/**
 * Display names for the theme variables. customThemes.js keeps the structure
 * (which keys exist, which take raw text) with English fallbacks; the text lives
 * here because THEME_VARS is a module constant and a t() in it would freeze the
 * load-time language.
 */

import { useMemo } from 'react';
import { useT } from '../../translations/index';

export default function useThemeVarLabels() {
  const { t } = useT();
  return useMemo(() => ({
    "--color-bg-base":         t("Window background"),
    "--color-bg-sidebar":      t("Activity bar"),
    "--color-bg-surface":      t("Panels & cards"),
    "--color-bg-hover":        t("Hover state"),
    "--color-title-bar":       t("Title bar"),
    "--color-sidebar-header":  t("Sidebar header"),
    "--color-bg-reader":       t("Reader background"),
    "--color-bg-editor":       t("Editor theme"),
    "--color-fg-primary":      t("Primary text"),
    "--color-fg-secondary":    t("Secondary text"),
    "--color-fg-icon":         t("Inactive icons"),
    "--color-accent":          t("Accent / active"),
    "--color-accent-subtle":   t("Accent tint"),
    "--color-on-accent":       t("Text on accent"),
    "--color-border":          t("Borders"),
    "--color-border-strong":   t("Input & control borders"),
    "--color-tree-indent":     t("Tree indent line"),
    "--color-hl-1":            t("Highlight 1"),
    "--color-hl-2":            t("Highlight 2"),
    "--color-hl-3":            t("Highlight 3"),
    "--color-hl-4":            t("Highlight 4"),
    "--color-on-review":       t("Review · Button label"),
    "--color-review-again":    t("Review · Again"),
    "--color-review-hard":     t("Review · Hard"),
    "--color-review-good":     t("Review · Good"),
    "--color-review-easy":     t("Review · Easy"),
    "--color-graph-edge":      t("Graph · Resting links"),
    "--color-graph-document":  t("Graph · Document"),
    "--color-graph-folder":    t("Graph · Folder"),
    "--color-graph-flashcard": t("Graph · Flashcard"),
    "--color-graph-tag":       t("Graph · Tag"),
    "--color-graph-deck":      t("Graph · Deck"),
    "--color-graph-link":      t("Graph · Link"),
    "--color-graph-disconnect":t("Graph · Disconnect"),
    "--color-graph-inherit":   t("Graph · Inherit"),
    "--color-danger":          t("Danger / error"),
    "--color-danger-bg":       t("Danger background"),
    "--color-on-danger":       t("Text on danger"),
    "--shadow-sm":             t("Resting shadow"),
    "--shadow-float":          t("Float shadow"),
  }), [t]);
}
