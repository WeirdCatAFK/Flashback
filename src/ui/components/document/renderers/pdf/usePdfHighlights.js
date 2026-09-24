/**
 * PDF highlights: the box-draw mode for scanned pages (a drag captures the app
 * zoom at mousedown, and a zoom change mid-drag aborts it), the hit test that
 * finds the highlight under a text selection, and the highlight command
 * contract. Bboxes are stored in PDF units — see geometry.js.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { getUiZoom, useUiZoomChange } from '../../../../utils/uiZoom';
import { generateHighlightId } from '../highlightId.js';
import { viewportToPdf, bboxFromViewport, dragRect, centerInPdf, highlightAt } from './geometry.js';

const QUOTE_MAX = 240;

const newHighlight = (page, bbox, color, text) => {
  const now = new Date().toISOString();
  return { id: generateHighlightId(), color, page, bbox, type: 'pdf_bbox', text, createdAt: now, updatedAt: now, cardHashes: [], refIds: [] };
};

export default function usePdfHighlights({ highlightRef, highlightsRef, setAll, pagesRef, scale, save }) {
  const [drawMode, setDrawMode] = useState(false);
  const overlayRef = useRef(null);
  const dragRef = useRef(null);
  const currentHlRef = useRef(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    if (overlayRef.current) overlayRef.current.style.display = 'none';
  }, []);

  useEffect(() => {
    if (!drawMode) { cancelDrag(); return undefined; }
    const pagesEl = pagesRef.current;
    if (!pagesEl) return undefined;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      const pageEl = e.target.closest('.pdf-page');
      if (!pageEl) return;
      e.preventDefault();
      const z = getUiZoom();
      dragRef.current = { pageNum: parseInt(pageEl.dataset.page, 10), pageEl, start: { x: e.clientX, y: e.clientY }, uiZoom: z };
      const o = overlayRef.current;
      if (o) { o.style.display = 'block'; o.style.left = e.clientX / z + 'px'; o.style.top = e.clientY / z + 'px'; o.style.width = '0'; o.style.height = '0'; }
    };
    const onMouseMove = (e) => {
      const d = dragRef.current;
      const o = overlayRef.current;
      if (!d || !o) return;
      const z = d.uiZoom;
      o.style.left = Math.min(e.clientX, d.start.x) / z + 'px';
      o.style.top = Math.min(e.clientY, d.start.y) / z + 'px';
      o.style.width = Math.abs(e.clientX - d.start.x) / z + 'px';
      o.style.height = Math.abs(e.clientY - d.start.y) / z + 'px';
    };
    const onMouseUp = (e) => {
      const d = dragRef.current;
      if (!d) return;
      cancelDrag();
      const rect = dragRect(d.start, { x: e.clientX, y: e.clientY });
      if (!rect) return;
      const bbox = bboxFromViewport(rect, d.pageEl.getBoundingClientRect(), viewportToPdf(scaleRef.current, getUiZoom()));
      setAll([...highlightsRef.current, newHighlight(d.pageNum, bbox, 'amber', '')]);
      save();
    };
    const onKeyDown = (e) => { if (e.key === 'Escape' && dragRef.current) cancelDrag(); };

    pagesEl.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      pagesEl.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawMode, pagesRef, highlightsRef, setAll, save, cancelDrag]);

  useUiZoomChange(() => { if (dragRef.current) cancelDrag(); });

  const selectionOnPage = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const pageEl = range.startContainer?.parentElement?.closest?.('.pdf-page');
    if (!pageEl) return null;
    return { sel, range, pageEl, pageNum: parseInt(pageEl.dataset.page, 10) };
  };

  const findOverlapping = useCallback(() => {
    try {
      const hit = selectionOnPage();
      if (!hit) return null;
      const divisor = viewportToPdf(scaleRef.current, getUiZoom());
      const center = centerInPdf(hit.range.getBoundingClientRect(), hit.pageEl.getBoundingClientRect(), divisor);
      return highlightAt(highlightsRef.current, hit.pageNum, center);
    } catch { return null; }
  }, [highlightsRef]);

  useEffect(() => {
    if (!highlightRef) return undefined;
    const removeById = (id) => {
      setAll(highlightsRef.current.filter((h) => h.id !== id));
      if (currentHlRef.current === id) currentHlRef.current = null;
      return { kind: 'removed', id };
    };
    const commands = {
      toggle: (color) => {
        try {
          const hit = selectionOnPage();
          if (!hit) return null;
          const existingId = findOverlapping();
          if (existingId) {
            const existing = highlightsRef.current.find((h) => h.id === existingId);
            if (existing?.color === color) return { kind: 'existing', id: existingId };
            setAll(highlightsRef.current.map((h) => (h.id === existingId ? { ...h, color, updatedAt: new Date().toISOString() } : h)));
            return { kind: 'recolored', id: existingId };
          }
          const divisor = viewportToPdf(scaleRef.current, getUiZoom());
          const bbox = bboxFromViewport(hit.range.getBoundingClientRect(), hit.pageEl.getBoundingClientRect(), divisor);
          const hl = newHighlight(hit.pageNum, bbox, color, hit.sel.toString().trim().slice(0, QUOTE_MAX));
          setAll([...highlightsRef.current, hl]);
          return { kind: 'created', id: hl.id };
        } catch { return null; }
      },
      unset: () => (currentHlRef.current ? removeById(currentHlRef.current) : null),
      remove: (id) => (id && highlightsRef.current.some((h) => h.id === id) ? removeById(id) : null),
      recolor: (id, color) => {
        const h = highlightsRef.current.find((x) => x.id === id);
        if (!h || h.color === color) return null;
        setAll(highlightsRef.current.map((x) => (x.id === id ? { ...x, color, updatedAt: new Date().toISOString() } : x)));
        return { kind: 'recolored', id };
      },
      ensure: (color = 'amber') => {
        const existing = findOverlapping();
        if (existing) { currentHlRef.current = existing; return { kind: 'existing', id: existing }; }
        return commands.toggle(color);
      },
      currentId: () => {
        const id = findOverlapping();
        currentHlRef.current = id;
        return id;
      },
      scrollTo: (id) => {
        const el = document.querySelector(`.pdf-hl[data-hl="${id}"]`);
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      },
    };
    highlightRef.current = commands;
    return () => { highlightRef.current = null; };
  });

  return { drawMode, toggleDrawMode: () => setDrawMode((m) => !m), overlayRef };
}
