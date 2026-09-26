/**
 * The editor's tab strip: which documents are open, which one is the preview
 * tab (a single click opens a preview that the next single click replaces; a
 * double click pins it), a highlight another view asked to jump to, and the
 * relocation of every path when a file or folder moves.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { relocatePath } from '../../utils/relocatePath';

export default function useOpenTabs({ selectedPath, onSelect, relocatePaths, openSource, onOpenSourceConsumed }) {
  const [openTabs, setOpenTabs] = useState([]);
  const [previewTab, setPreviewTab] = useState(null);
  const [pendingHighlight, setPendingHighlight] = useState(null);
  const [relocation, setRelocation] = useState(null);
  const openTabsRef = useRef([]);
  openTabsRef.current = openTabs;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const consumedRef = useRef(onOpenSourceConsumed);
  consumedRef.current = onOpenSourceConsumed;

  const relocateTabs = useCallback((from, to) => {
    setOpenTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        const np = relocatePath(tab.path, from, to);
        if (np !== tab.path) changed = true;
        return np === tab.path ? tab : { ...tab, path: np };
      });
      return changed ? next : prev;
    });
    setPreviewTab((prev) => relocatePath(prev, from, to));
    setPendingHighlight((prev) => (prev ? { ...prev, path: relocatePath(prev.path, from, to) } : prev));
    setRelocation({ from, to });
    relocatePaths(from, to);
  }, [relocatePaths]);

  useEffect(() => {
    if (!openSource) return;
    const { path, highlightId } = openSource;
    setOpenTabs((prev) => (prev.some((tab) => tab.path === path) ? prev : [...prev, { path }]));
    onSelectRef.current(path);
    consumedRef.current?.();
    if (highlightId) setPendingHighlight({ path, id: highlightId });
  }, [openSource]);

  const openReplacingPreview = (path) => {
    if (openTabsRef.current.some((tab) => tab.path === path)) return false;
    setOpenTabs((prev) => {
      const base = previewTab && previewTab !== path ? prev.filter((tab) => tab.path !== previewTab) : prev;
      return [...base, { path }];
    });
    return true;
  };

  const select = useCallback((path) => {
    if (openReplacingPreview(path)) setPreviewTab(path);
    onSelect(path);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewTab, onSelect]);

  const pin = useCallback((path) => {
    openReplacingPreview(path);
    setPreviewTab((prev) => (prev === path ? null : prev));
    onSelect(path);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewTab, onSelect]);

  const close = useCallback((path) => {
    setOpenTabs((prev) => {
      const next = prev.filter((tab) => tab.path !== path);
      if (selectedPath === path) onSelect(next.length > 0 ? next[next.length - 1].path : null);
      return next;
    });
    setPreviewTab((prev) => (prev === path ? null : prev));
  }, [selectedPath, onSelect]);

  return {
    openTabs, previewTab, pendingHighlight, relocation, relocateTabs, select, pin, close,
    pinTab: useCallback((path) => setPreviewTab((prev) => (prev === path ? null : prev)), []),
    consumeHighlight: () => setPendingHighlight(null),
  };
}
