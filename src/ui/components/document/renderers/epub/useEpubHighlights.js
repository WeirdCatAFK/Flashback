/**
 * EPUB highlights: anchored by CFI range, painted through epub.js annotations
 * (kept in step with the list by diffing what has been applied), and the
 * highlight command contract driven by the pending in-iframe selection.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { generateHighlightId } from '../highlightId.js';
import { resolveColor } from './epubTheme.js';

const QUOTE_MAX = 240;

export default function useEpubHighlights({ highlightRef }) {
  const [highlights, setHighlights] = useState([]);
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const pendingSelRef = useRef(null);
  const currentHlRef = useRef(null);
  const appliedRef = useRef(new Map());
  const renditionRef = useRef(null);
  const [ready, setReady] = useState(false);

  const setAll = useCallback((next) => { highlightsRef.current = next; setHighlights(next); }, []);
  const findByCfi = (cfi) => highlightsRef.current.find((h) => h.cfi === cfi);

  const addHighlight = useCallback((cfiRange, color, text) => {
    const now = new Date().toISOString();
    const hl = {
      id: generateHighlightId(), color, type: 'epub_cfi', cfi: cfiRange,
      text: (text ?? '').trim().slice(0, QUOTE_MAX), createdAt: now, updatedAt: now, cardHashes: [], refIds: [],
    };
    setAll([...highlightsRef.current, hl]);
    currentHlRef.current = hl.id;
    return hl.id;
  }, [setAll]);

  const removeHighlight = useCallback((id) => {
    setAll(highlightsRef.current.filter((h) => h.id !== id));
    if (currentHlRef.current === id) currentHlRef.current = null;
  }, [setAll]);

  /** Bind the rendition once the book is open; annotations are diffed against `applied`. */
  const attach = useCallback((rendition, isReady) => {
    renditionRef.current = rendition;
    if (!isReady) appliedRef.current = new Map();
    setReady(isReady);
  }, []);

  useEffect(() => {
    const rend = renditionRef.current;
    if (!rend || !ready) return;
    const desired = new Map(highlights.map((h) => [h.cfi, h.color]));
    for (const [cfi, color] of appliedRef.current) {
      if (desired.get(cfi) !== color) {
        try { rend.annotations.remove(cfi, 'highlight'); } catch { }
        appliedRef.current.delete(cfi);
      }
    }
    for (const h of highlights) {
      if (appliedRef.current.get(h.cfi) === h.color) continue;
      try {
        rend.annotations.add('highlight', h.cfi, { id: h.id }, () => { currentHlRef.current = h.id; }, '', { fill: resolveColor(h.color), 'fill-opacity': '0.3' });
        appliedRef.current.set(h.cfi, h.color);
      } catch { }
    }
  }, [highlights, ready]);

  useEffect(() => {
    if (!highlightRef) return undefined;
    const commands = {
      toggle: (color) => {
        const pend = pendingSelRef.current;
        if (!pend) return null;
        const existing = findByCfi(pend.cfiRange);
        if (existing) {
          currentHlRef.current = existing.id;
          if (existing.color === color) return { kind: 'existing', id: existing.id };
          setAll(highlightsRef.current.map((h) => (h.id === existing.id ? { ...h, color, updatedAt: new Date().toISOString() } : h)));
          return { kind: 'recolored', id: existing.id };
        }
        return { kind: 'created', id: addHighlight(pend.cfiRange, color, pend.text) };
      },
      ensure: (color = 'amber') => {
        const pend = pendingSelRef.current;
        if (!pend) return null;
        const existing = findByCfi(pend.cfiRange);
        if (existing) { currentHlRef.current = existing.id; return { kind: 'existing', id: existing.id }; }
        return { kind: 'created', id: addHighlight(pend.cfiRange, color, pend.text) };
      },
      unset: () => {
        const pend = pendingSelRef.current;
        const id = currentHlRef.current ?? (pend && findByCfi(pend.cfiRange)?.id) ?? null;
        if (!id) return null;
        removeHighlight(id);
        return { kind: 'removed', id };
      },
      remove: (id) => {
        if (!id || !highlightsRef.current.some((h) => h.id === id)) return null;
        removeHighlight(id);
        return { kind: 'removed', id };
      },
      currentId: () => {
        const pend = pendingSelRef.current;
        const id = (pend && findByCfi(pend.cfiRange)?.id) ?? currentHlRef.current ?? null;
        currentHlRef.current = id;
        return id;
      },
      scrollTo: (id) => {
        const h = highlightsRef.current.find((x) => x.id === id);
        if (!h?.cfi) return false;
        renditionRef.current?.display(h.cfi);
        return true;
      },
    };
    highlightRef.current = commands;
    return () => { highlightRef.current = null; };
  });

  return {
    highlightsRef,
    setAll,
    attach,
    onSelection: (sel) => { pendingSelRef.current = sel; },
    onMarkClicked: (cfiRange) => { const h = findByCfi(cfiRange); if (h) currentHlRef.current = h.id; },
  };
}
