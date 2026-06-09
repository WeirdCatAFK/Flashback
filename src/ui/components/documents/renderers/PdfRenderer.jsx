import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { readFile, updateMetadata } from '../../../api/documents';
import { getBaseUrl } from '../../../api/client';
import './PdfRenderer.css';
import './Renderer.css';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const SCALE_MIN  = 0.5;
const SCALE_MAX  = 3.0;
const SCALE_STEP = 0.25;
const SCALE_DEFAULT = 1.2;

function generateId() {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return 'h_' + (rand[0].toString(36) + rand[1].toString(36)).slice(0, 9);
}

// --- PdfPage ---

function PdfPage({ page, scale, highlights }) {
  // Viewport recomputed whenever scale changes
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);

  const containerRef = useRef(null);
  const canvasRef    = useRef(null);
  const textDivRef   = useRef(null);
  const [visible, setVisible] = useState(false);

  // Lazy: render when the page enters the scroll viewport (keep observing so
  // zoom-induced layout changes can bring new pages into view without a new mount)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { rootMargin: '200px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Canvas — re-runs on every viewport change (i.e. on every zoom change)
  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = viewport.width  * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width  = viewport.width  + 'px';
    canvas.style.height = viewport.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const task = page.render({ canvasContext: ctx, viewport });
    task.promise.catch(() => {});
    return () => task.cancel();
  }, [visible, page, viewport]);

  // Text layer — independent of canvas; re-runs on zoom too
  useEffect(() => {
    if (!visible || !textDivRef.current) return;
    const div = textDivRef.current;
    div.innerHTML = '';
    let layer = null;
    let cancelled = false;
    page.getTextContent().then(tc => {
      if (cancelled) return;
      layer = new TextLayer({ textContentSource: tc, container: div, viewport });
      return layer.render();
    }).catch(() => {});
    return () => { cancelled = true; layer?.cancel(); };
  }, [visible, page, viewport]);

  // CSS variables required by pdfjs-dist v6's TextLayer for container sizing
  // and span font-size / transform (inherited from the page container).
  const pageVars = {
    '--total-scale-factor': scale,
    '--scale-round-x': '1px',
    '--scale-round-y': '1px',
  };

  return (
    <div
      ref={containerRef}
      className="pdf-page"
      data-page={page.pageNumber}
      style={{ width: viewport.width, height: viewport.height, ...pageVars }}
    >
      {visible && <canvas ref={canvasRef} />}
      {/* Highlight layer sits behind the text layer so text selection works */}
      <div className="pdf-hl-layer">
        {highlights.map(h => h.bbox && (
          <div
            key={h.id}
            className={`pdf-hl pdf-hl--${h.color ?? 'amber'}`}
            data-hl={h.id}
            style={{
              left:   h.bbox.x * scale,
              top:    h.bbox.y * scale,
              width:  h.bbox.width  * scale,
              height: h.bbox.height * scale,
            }}
          />
        ))}
      </div>
      {/* Text layer: no explicit width/height — setLayerDimensions sets them via CSS vars */}
      {visible && <div ref={textDivRef} className="pdf-text-layer" />}
    </div>
  );
}

// --- PdfRenderer ---

export default function PdfRenderer({
  path,
  saveRef,
  highlightRef,
  onHighlightsChange,
  onSidecarRefresh,
}) {
  const [pages,      setPages]      = useState([]);
  const [highlights, setHighlights] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [scale,      setScale]      = useState(SCALE_DEFAULT);

  const pathRef       = useRef(path);
  pathRef.current     = path;
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const currentHlRef  = useRef(null);
  const loadedPathRef = useRef(null);
  const scaleRef      = useRef(scale);
  scaleRef.current    = scale;
  const rendererRef   = useRef(null);

  // Load PDF + sidecar
  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    setPages([]);
    setHighlights([]);
    highlightsRef.current = [];
    loadedPathRef.current = null;

    const pdfUrl = `${getBaseUrl()}/api/documents/raw?path=${encodeURIComponent(path)}`;
    let mounted = true;

    Promise.all([
      getDocument({ url: pdfUrl }).promise,
      readFile(path).then(d => d.metadata ?? {}).catch(() => ({})),
    ]).then(async ([pdf, meta]) => {
      if (!mounted) return;
      const nums = Array.from({ length: pdf.numPages }, (_, i) => i + 1);
      const pgs  = await Promise.all(nums.map(n => pdf.getPage(n)));
      if (!mounted) return;
      const hls = meta.highlights ?? [];
      setPages(pgs);
      setHighlights(hls);
      highlightsRef.current = hls;
      loadedPathRef.current = path;
      onHighlightsChange?.(path, hls);
      onSidecarRefresh?.(path, meta);
      setLoading(false);
    }).catch(err => {
      if (!mounted) return;
      setError(err.message ?? 'Failed to load PDF');
      setLoading(false);
    });

    return () => { mounted = false; };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Zoom helpers
  const zoomOut  = useCallback(() => setScale(s => Math.max(SCALE_MIN,  parseFloat((s - SCALE_STEP).toFixed(2)))), []);
  const zoomIn   = useCallback(() => setScale(s => Math.min(SCALE_MAX,  parseFloat((s + SCALE_STEP).toFixed(2)))), []);
  const fitWidth = useCallback(() => {
    if (!rendererRef.current || !pages[0]) return;
    const nativeW = pages[0].getViewport({ scale: 1 }).width;
    const available = rendererRef.current.clientWidth - 48; // 24px padding each side
    setScale(parseFloat(Math.min(SCALE_MAX, Math.max(SCALE_MIN, available / nativeW)).toFixed(2)));
  }, [pages]);

  // Save: update sidecar only (PDF body is never modified)
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async (metaTransform) => {
    const savedPath = pathRef.current;
    if (loadedPathRef.current !== savedPath) return;
    try {
      let baseMeta = {};
      try { baseMeta = (await readFile(savedPath)).metadata ?? {}; } catch { /* ok */ }
      if (metaTransform) baseMeta = metaTransform(baseMeta);
      const nextMeta = { ...baseMeta, highlights: highlightsRef.current };
      await updateMetadata(savedPath, nextMeta);
      onHighlightsChange?.(savedPath, highlightsRef.current);
      onSidecarRefresh?.(savedPath, nextMeta);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (saveRef) saveRef.current = (meta) => handleSaveRef.current?.(meta);
    return () => { if (saveRef) saveRef.current = null; };
  });

  // Find the highlight (if any) whose bbox contains the centre of the current selection
  const findOverlappingHighlight = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    try {
      const range   = sel.getRangeAt(0);
      const pageEl  = range.startContainer?.parentElement?.closest?.('.pdf-page');
      if (!pageEl) return null;
      const pageNum = parseInt(pageEl.dataset.page, 10);
      const pr = pageEl.getBoundingClientRect();
      const sr = range.getBoundingClientRect();
      const cx = ((sr.left + sr.right)  / 2 - pr.left) / scaleRef.current;
      const cy = ((sr.top  + sr.bottom) / 2 - pr.top)  / scaleRef.current;
      return (
        highlightsRef.current.find(h =>
          h.page === pageNum && h.bbox &&
          cx >= h.bbox.x && cx <= h.bbox.x + h.bbox.width &&
          cy >= h.bbox.y && cy <= h.bbox.y + h.bbox.height
        )?.id ?? null
      );
    } catch { return null; }
  }, []);

  // highlightRef commands
  useEffect(() => {
    if (!highlightRef) return;

    const commands = {
      toggle: (color) => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return null;
        try {
          const range  = sel.getRangeAt(0);
          const pageEl = range.startContainer?.parentElement?.closest?.('.pdf-page');
          if (!pageEl) return null;
          const pageNum = parseInt(pageEl.dataset.page, 10);

          // Recolor or remove existing highlight under selection
          const existingId = findOverlappingHighlight();
          if (existingId) {
            const existing = highlightsRef.current.find(h => h.id === existingId);
            if (existing?.color === color) {
              const next = highlightsRef.current.filter(h => h.id !== existingId);
              highlightsRef.current = next; setHighlights(next);
              return { kind: 'removed', id: existingId };
            }
            const next = highlightsRef.current.map(h =>
              h.id === existingId ? { ...h, color, updatedAt: new Date().toISOString() } : h
            );
            highlightsRef.current = next; setHighlights(next);
            return { kind: 'recolored', id: existingId };
          }

          // New highlight — bbox in PDF units at scale=1
          const sc = scaleRef.current;
          const pr = pageEl.getBoundingClientRect();
          const rr = range.getBoundingClientRect();
          const bbox = {
            x:      (rr.left   - pr.left) / sc,
            y:      (rr.top    - pr.top)  / sc,
            width:  rr.width               / sc,
            height: rr.height              / sc,
          };
          const now = new Date().toISOString();
          const id  = generateId();
          const hl  = {
            id, color, page: pageNum, bbox, type: 'pdf_bbox',
            text: sel.toString().trim().slice(0, 240),
            createdAt: now, updatedAt: now, cardHashes: [], refIds: [],
          };
          const next = [...highlightsRef.current, hl];
          highlightsRef.current = next; setHighlights(next);
          return { kind: 'created', id };
        } catch { return null; }
      },

      unset: () => {
        const id = currentHlRef.current;
        if (!id) return null;
        const next = highlightsRef.current.filter(h => h.id !== id);
        highlightsRef.current = next; setHighlights(next);
        currentHlRef.current = null;
        return { kind: 'removed', id };
      },

      ensure: (color = 'amber') => {
        const existing = findOverlappingHighlight();
        if (existing) { currentHlRef.current = existing; return { kind: 'existing', id: existing }; }
        return commands.toggle(color);
      },

      currentId: () => {
        const id = findOverlappingHighlight();
        currentHlRef.current = id;
        return id;
      },

      scrollTo: (id) => {
        const el = document.querySelector(`.pdf-hl[data-hl="${id}"]`);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return true; }
        return false;
      },
    };

    highlightRef.current = commands;
    return () => { if (highlightRef) highlightRef.current = null; };
  });

  if (loading) return <div className="renderer-loading">Loading PDF…</div>;
  if (error)   return <div className="renderer-error">Could not load PDF: {error}</div>;

  return (
    <div className="pdf-renderer" ref={rendererRef}>
      <div className="pdf-zoom-bar">
        <button
          className="pdf-zoom-btn"
          onClick={zoomOut}
          disabled={scale <= SCALE_MIN}
          title="Zoom out"
        >−</button>
        <span className="pdf-zoom-label">{Math.round(scale * 100)}%</span>
        <button
          className="pdf-zoom-btn"
          onClick={zoomIn}
          disabled={scale >= SCALE_MAX}
          title="Zoom in"
        >+</button>
        <button className="pdf-zoom-btn pdf-zoom-btn--fit" onClick={fitWidth} title="Fit width">
          Fit
        </button>
      </div>

      <div className="pdf-pages">
        {pages.map(page => (
          <PdfPage
            key={page.pageNumber}
            page={page}
            scale={scale}
            highlights={highlights.filter(h => h.page === page.pageNumber)}
          />
        ))}
      </div>
    </div>
  );
}

PdfRenderer.supportsHighlight = true;
