/**
 * EPUB highlights: anchored by CFI range, painted through epub.js annotations
 * (kept in step with the list by diffing what has been applied), and the
 * highlight command contract driven by the pending in-iframe selection. Also
 * where a click lands among them (`hitAt`) and where each sits for the card
 * margin (`measureMargin`), both read from the section frames, since epub.js draws
 * highlights on a layer that ignores the pointer and carries no `data-hl`.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { generateHighlightId } from '../highlightId.js';
import { resolveColor } from './epubTheme.js';

const QUOTE_MAX = 240;

/**
 * A highlight's range in one section's document, or null when it belongs to
 * another section: a CFI's steps would resolve to the wrong nodes elsewhere.
 */
function rangeIn(contents, h) {
  if (!h.cfi || !h.cfi.startsWith(`epubcfi(${contents.cfiBase}!`)) return null;
  try { return contents.range(h.cfi) ?? null; } catch { return null; }
}

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
      recolor: (id, color) => {
        const h = highlightsRef.current.find((x) => x.id === id);
        if (!h || h.color === color) return null;
        setAll(highlightsRef.current.map((x) => (x.id === id ? { ...x, color, updatedAt: new Date().toISOString() } : x)));
        return { kind: 'recolored', id };
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

  /**
   * The highlight under a click in one section's frame, and its rect in that frame.
   * epub.js draws highlights on a layer that ignores the pointer (so the text under
   * it stays selectable), so a click is matched against each highlight's ranges.
   */
  function hitAt(contents, x, y) {
    for (const h of highlightsRef.current) {
      const range = rangeIn(contents, h);
      if (!range) continue;
      for (const r of range.getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          currentHlRef.current = h.id;
          return { id: h.id, rect: range.getBoundingClientRect() };
        }
      }
    }
    return null;
  }

  /**
   * The card margin's measurements, in the scrolling container's content space:
   * the top of each highlight's first line among the sections on the page, and
   * the right edge of the text column (the section body, less its padding).
   */
  const measureMargin = useCallback((sc, box, z) => {
    const anchors = new Map();
    let right = 0;
    for (const contents of renditionRef.current?.getContents?.() ?? []) {
      const doc = contents.document;
      const frame = doc?.defaultView?.frameElement?.getBoundingClientRect();
      if (!frame) continue;
      if (doc.body) {
        const b = doc.body.getBoundingClientRect();
        const pad = parseFloat(doc.defaultView.getComputedStyle(doc.body).paddingRight) || 0;
        right = Math.max(right, (frame.left - box.left) / z + b.right - pad);
      }
      for (const h of highlightsRef.current) {
        if (anchors.has(h.id)) continue;
        const range = rangeIn(contents, h);
        const r = range?.getClientRects()[0];
        if (!r) continue;
        anchors.set(h.id, (frame.top - box.top) / z + r.top + sc.scrollTop);
      }
    }
    return { anchors, right };
  }, []);

  return {
    highlightsRef,
    setAll,
    measureMargin,
    attach,
    onSelection: (sel) => { pendingSelRef.current = sel; },
    onMarkClicked: (cfiRange) => { const h = findByCfi(cfiRange); if (h) currentHlRef.current = h.id; },
    hitAt,
  };
}
