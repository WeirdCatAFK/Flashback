/**
 * A PDF's lifecycle: load the file through pdf.js and the sidecar together,
 * hold the pages and highlights, track and report the page in view, resume the
 * saved position once both are ready, and save the sidecar on Ctrl+S. Nothing
 * the renderer owns scrolls, so the scroller is looked up (findScroller) and
 * re-bound when the scale changes — a short PDF only acquires one when zoomed.
 * Ctrl+wheel and a trackpad pinch zoom around the cursor: the wheel handler notes
 * where the cursor sits in the scroller, and once the new scale is laid out the
 * scroller is moved so the same point of the page is back under it.
 */

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { readFile, updateMetadata, rawDocumentUrl } from '../../../../api/documents';
import { useT } from '../../../../translations/index';
import { getUiZoom } from '../../../../utils/uiZoom';
import { findScroller } from '../scroller';
import { SCALE_DEFAULT, zoomedIn, zoomedOut, fitScale, pageAtTop, wheelScale } from './geometry.js';
import { getDocument } from './pdfjs.js';

export default function usePdfDocument({ path, saveRef, onHighlightsChange, onSidecarRefresh, initialProgress, onProgress, progressRef }) {
  const { t } = useT();
  const [pages, setPages] = useState([]);
  const [highlights, setHighlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [scale, setScale] = useState(SCALE_DEFAULT);
  const pathRef = useRef(path);
  pathRef.current = path;
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const loadedPathRef = useRef(null);
  const rendererRef = useRef(null);
  const pagesRef = useRef(null);
  const resumedRef = useRef(false);
  const currentPageRef = useRef(1);

  const setAll = useCallback((next) => { highlightsRef.current = next; setHighlights(next); }, []);

  useEffect(() => {
    if (!path) return undefined;
    setLoading(true);
    setError(null);
    setPages([]);
    setAll([]);
    loadedPathRef.current = null;
    resumedRef.current = false;
    let mounted = true;

    Promise.all([
      getDocument({ url: rawDocumentUrl(path) }).promise,
      readFile(path).then((d) => d.metadata ?? {}).catch(() => ({})),
    ]).then(async ([pdf, meta]) => {
      if (!mounted) return;
      const nums = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
      const pgs = await Promise.all(nums.map((n) => pdf.getPage(n)));
      if (!mounted) return;
      const hls = meta.highlights ?? [];
      setPages(pgs);
      setAll(hls);
      loadedPathRef.current = path;
      onHighlightsChange?.(path, hls);
      onSidecarRefresh?.(path, meta);
      setLoading(false);
    }).catch((err) => {
      if (!mounted) return;
      setError(err.message ?? t('Failed to load PDF'));
      setLoading(false);
    });
    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const scrollToPage = useCallback((pageNumber) => {
    const el = pagesRef.current?.querySelector(`[data-page="${pageNumber}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: 'start' });
    return true;
  }, []);

  useEffect(() => {
    if (resumedRef.current || !pages.length || initialProgress === undefined) return;
    resumedRef.current = true;
    const page = initialProgress?.position?.page;
    if (page && page > 1 && page <= pages.length) scrollToPage(page);
  }, [pages, initialProgress, scrollToPage]);

  const scroller = useCallback(() => findScroller(rendererRef.current), []);

  useEffect(() => {
    if (!pages.length || !onProgress) return undefined;
    const el = scroller();
    if (!el) return undefined;
    const report = () => {
      const top = el.getBoundingClientRect().top;
      const bottoms = [...(pagesRef.current?.querySelectorAll('[data-page]') ?? [])]
        .map((node) => ({ page: Number(node.dataset.page) || 1, bottom: node.getBoundingClientRect().bottom }));
      const current = pageAtTop(bottoms, top);
      if (current === currentPageRef.current) return;
      currentPageRef.current = current;
      onProgress(path, { unit: 'page', position: { page: current }, percent: current / pages.length, total: pages.length });
    };
    el.addEventListener('scroll', report, { passive: true });
    return () => el.removeEventListener('scroll', report);
  }, [pages, path, onProgress, scroller, scale]);

  useEffect(() => {
    if (!progressRef) return undefined;
    progressRef.current = {
      goToStart: () => { scroller()?.scrollTo({ top: 0 }); },
      currentPosition: () => ({
        unit: 'page',
        position: { page: currentPageRef.current },
        percent: pages.length ? currentPageRef.current / pages.length : null,
        total: pages.length,
      }),
    };
    return () => { progressRef.current = null; };
  }, [progressRef, pages, scroller]);

  const saveHandlerRef = useRef(null);
  saveHandlerRef.current = async (metaTransform) => {
    const savedPath = pathRef.current;
    if (loadedPathRef.current !== savedPath) return;
    try {
      let baseMeta = {};
      try { baseMeta = (await readFile(savedPath)).metadata ?? {}; } catch { }
      if (metaTransform) baseMeta = metaTransform(baseMeta);
      const nextMeta = { ...baseMeta, highlights: highlightsRef.current };
      await updateMetadata(savedPath, nextMeta);
      onHighlightsChange?.(savedPath, highlightsRef.current);
      onSidecarRefresh?.(savedPath, nextMeta);
    } catch { }
  };

  useEffect(() => {
    if (saveRef) saveRef.current = (meta) => saveHandlerRef.current?.(meta);
    return () => { if (saveRef) saveRef.current = null; };
  });

  const anchorRef = useRef(null);
  const prevScaleRef = useRef(scale);

  useEffect(() => {
    const el = rendererRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const box = scroller();
      if (box) {
        const r = box.getBoundingClientRect();
        const z = getUiZoom();
        anchorRef.current = { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
      }
      setScale((s) => wheelScale(s, e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pages, scroller]);

  useLayoutEffect(() => {
    const prev = prevScaleRef.current;
    prevScaleRef.current = scale;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const box = anchor && prev !== scale ? scroller() : null;
    if (!box) return;
    const k = scale / prev;
    box.scrollTop = (box.scrollTop + anchor.y) * k - anchor.y;
    box.scrollLeft = (box.scrollLeft + anchor.x) * k - anchor.x;
  }, [scale, scroller]);

  const fitWidth = useCallback(() => {
    if (!rendererRef.current || !pages[0]) return;
    setScale(fitScale(rendererRef.current.clientWidth, pages[0].getViewport({ scale: 1 }).width));
  }, [pages]);

  return {
    pages, highlights, highlightsRef, setAll, loading, error, scale,
    rendererRef, pagesRef,
    zoomIn: () => setScale(zoomedIn), zoomOut: () => setScale(zoomedOut), zoomTo: setScale, fitWidth,
    save: () => saveHandlerRef.current?.(),
  };
}
