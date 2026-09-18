/**
 * An EPUB's lifecycle through epub.js: fetch the bytes once with auth (every
 * chapter and image is then served from memory), open a paginated rendition
 * themed from the app's CSS variables, wire it up once per load (so handlers
 * read refs, never state), publish the reading position — the CFI resumes the
 * renderer, the section href addresses /api/reader — resume once both the book
 * and the saved position are ready, and save the sidecar on Ctrl+S.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import ePub from 'epubjs';
import { readFile, updateMetadata, fetchRaw } from '../../../../api/documents';
import { useUiZoomChange } from '../../../../utils/uiZoom';
import { useT } from '../../../../translations/index';
import { renditionTheme, clampFont, FONT_DEFAULT } from './epubTheme.js';
import { toShellRect, hrefFromRenderedSrc } from './geometry.js';

const LOCATIONS_CHARS = 1600;
const RESIZE_DEBOUNCE = 150;

export default function useEpubBook({
  path, saveRef, onHighlightsChange, onSidecarRefresh, onExternalSelection, initialProgress, onProgress, progressRef, highlightsRef, setAll, onSelection, onMarkClicked,
}) {
  const { t } = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);
  const [fontPct, setFontPct] = useState(FONT_DEFAULT);
  const [progress, setProgress] = useState(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const [imageHit, setImageHit] = useState(null);

  const viewportRef = useRef(null);
  const bookRef = useRef(null);
  const renditionRef = useRef(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const loadedPathRef = useRef(null);
  const fontPctRef = useRef(fontPct);
  fontPctRef.current = fontPct;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onExternalSelectionRef = useRef(onExternalSelection);
  onExternalSelectionRef.current = onExternalSelection;
  const onSelectionRef = useRef(onSelection);
  onSelectionRef.current = onSelection;
  const onMarkClickedRef = useRef(onMarkClicked);
  onMarkClickedRef.current = onMarkClicked;
  const lastPosRef = useRef(null);
  const lastPctRef = useRef(null);
  const locationsReadyRef = useRef(false);
  const resumedRef = useRef(false);

  const publishLocation = useCallback((loc) => {
    const raw = loc?.start?.percentage;
    const pct = locationsReadyRef.current && typeof raw === 'number' ? raw : null;
    lastPctRef.current = pct;
    setProgress(pct != null && pct > 0 ? Math.round(pct * 100) : null);
    const cfi = loc?.start?.cfi;
    if (!cfi) return;
    lastPosRef.current = { cfi, href: loc.start.href ?? null, section: loc.start.index ?? null };
    onProgressRef.current?.(pathRef.current, {
      unit: 'section',
      position: lastPosRef.current,
      percent: pct,
      total: bookRef.current?.spine?.length ?? null,
    });
  }, []);

  const wireRendition = useCallback((rendition) => {
    rendition.on('selected', (cfiRange, contents) => {
      let text = '';
      let rect = null;
      try {
        const range = contents.range(cfiRange);
        text = range?.toString() ?? '';
        rect = toShellRect(contents, range?.getBoundingClientRect());
      } catch { }
      onSelectionRef.current?.({ cfiRange, text });
      setImageHit(null);
      if (rect) onExternalSelectionRef.current?.({ text: text.trim(), rect });
    });
    rendition.on('markClicked', (cfiRange) => onMarkClickedRef.current?.(cfiRange));
    rendition.hooks.content.register((contents) => {
      const doc = contents.document;
      doc.addEventListener('selectionchange', () => {
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed) {
          onSelectionRef.current?.(null);
          onExternalSelectionRef.current?.(null);
        }
      });
      doc.addEventListener('click', (e) => {
        const el = e.target?.closest?.('img, image');
        if (!el || !doc.getSelection()?.isCollapsed) return setImageHit(null);
        const src = el.getAttribute('src') ?? el.getAttribute('xlink:href') ?? el.getAttribute('href');
        const href = hrefFromRenderedSrc(bookRef.current, src);
        if (!href) return setImageHit(null);
        const rect = toShellRect(contents, el.getBoundingClientRect());
        if (!rect) return setImageHit(null);
        return setImageHit({ href, name: href.split('/').pop(), alt: el.getAttribute('alt') ?? null, rect });
      });
    });
    rendition.on('relocated', (loc) => {
      publishLocation(loc);
      setAtStart(!!loc?.atStart);
      setAtEnd(!!loc?.atEnd);
      setImageHit(null);
    });
  }, [publishLocation]);

  useEffect(() => {
    if (!path) return undefined;
    let cancelled = false;
    let book = null;
    let rendition = null;
    setLoading(true);
    setError(null);
    setReady(false);
    setProgress(null);
    lastPctRef.current = null;
    locationsReadyRef.current = false;
    loadedPathRef.current = null;
    resumedRef.current = false;

    (async () => {
      try {
        const [buf, meta] = await Promise.all([
          fetchRaw(path),
          readFile(path).then((d) => d.metadata ?? {}).catch(() => ({})),
        ]);
        if (cancelled || !viewportRef.current) return;
        book = ePub(buf);
        bookRef.current = book;
        rendition = book.renderTo(viewportRef.current, { width: '100%', height: '100%', flow: 'paginated', spread: 'none', allowScriptedContent: false });
        renditionRef.current = rendition;
        rendition.themes.register('fb', renditionTheme());
        rendition.themes.select('fb');
        rendition.themes.fontSize(`${fontPctRef.current}%`);
        wireRendition(rendition);

        const hls = meta.highlights ?? [];
        setAll(hls);
        await rendition.display();
        if (cancelled) return;
        loadedPathRef.current = path;
        onHighlightsChange?.(path, hls);
        onSidecarRefresh?.(path, meta);
        setReady(true);
        setLoading(false);

        book.ready
          .then(() => book.locations.generate(LOCATIONS_CHARS))
          .then(() => {
            if (cancelled || loadedPathRef.current !== path) return;
            locationsReadyRef.current = true;
            const loc = rendition?.currentLocation?.();
            if (loc?.start) publishLocation(loc);
          })
          .catch(() => {});
      } catch (err) {
        if (!cancelled) {
          setError(err?.message ?? t('Failed to load EPUB'));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      try { rendition?.destroy(); } catch { }
      try { book?.destroy(); } catch { }
      renditionRef.current = null;
      bookRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    if (resumedRef.current || !ready || initialProgress === undefined) return;
    resumedRef.current = true;
    const cfi = initialProgress?.position?.cfi;
    if (cfi) renditionRef.current?.display(cfi).catch(() => {});
  }, [ready, initialProgress]);

  useEffect(() => {
    if (!progressRef) return undefined;
    progressRef.current = {
      goToStart: () => { renditionRef.current?.display().catch(() => {}); },
      currentPosition: () => (lastPosRef.current ? {
        unit: 'section',
        position: lastPosRef.current,
        percent: lastPctRef.current,
        total: bookRef.current?.spine?.length ?? null,
      } : null),
    };
    return () => { progressRef.current = null; };
  }, [progressRef]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    let timer = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { try { renditionRef.current?.resize(); } catch { } }, RESIZE_DEBOUNCE);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(timer); };
  }, []);

  useUiZoomChange(() => setImageHit(null));

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

  const goPrev = useCallback(() => renditionRef.current?.prev(), []);
  const goNext = useCallback(() => renditionRef.current?.next(), []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'Escape') setImageHit(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext]);

  const changeFont = useCallback((delta) => {
    setFontPct((p) => {
      const n = clampFont(p + delta);
      try { renditionRef.current?.themes.fontSize(`${n}%`); } catch { }
      return n;
    });
  }, []);

  return {
    viewportRef, renditionRef, loading, error, ready, fontPct, progress, atStart, atEnd,
    imageHit, dismissImage: () => setImageHit(null), goPrev, goNext, changeFont,
  };
}
