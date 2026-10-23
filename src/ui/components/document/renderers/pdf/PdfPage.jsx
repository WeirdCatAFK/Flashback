/**
 * PdfPage — one page: a canvas rendered lazily when it scrolls near the
 * viewport, the highlight boxes over it, and pdf.js's text layer for selection.
 * The `--total-scale-factor` / `--scale-round-*` variables are what pdfjs-dist
 * v6's TextLayer reads to size its spans. A zoom resizes the page at once but
 * redraws the canvas and text layer only once it has settled (`drawn`): a pinch
 * changes the scale every frame, and redrawing on each one clears the canvas to
 * blank, so mid-gesture the previous drawing is stretched to the new size instead.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { TextLayer } from 'pdfjs-dist';

const PRELOAD_MARGIN = '200px';
const REDRAW_DELAY = 150;

export default function PdfPage({ page, scale, highlights }) {
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const textDivRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [drawn, setDrawn] = useState(viewport);

  useEffect(() => {
    if (drawn === viewport) return undefined;
    const timer = setTimeout(() => setDrawn(viewport), REDRAW_DELAY);
    return () => clearTimeout(timer);
  }, [viewport, drawn]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const obs = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setVisible(true); }, { rootMargin: PRELOAD_MARGIN });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !canvasRef.current) return undefined;
    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = drawn.width * dpr;
    canvas.height = drawn.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const task = page.render({ canvasContext: ctx, viewport: drawn });
    task.promise.catch(() => {});
    return () => task.cancel();
  }, [visible, page, drawn]);

  useEffect(() => {
    if (!visible || !textDivRef.current) return undefined;
    const div = textDivRef.current;
    div.innerHTML = '';
    let layer = null;
    let cancelled = false;
    page.getTextContent().then((tc) => {
      if (cancelled) return undefined;
      layer = new TextLayer({ textContentSource: tc, container: div, viewport: drawn });
      return layer.render();
    }).catch(() => {});
    return () => { cancelled = true; layer?.cancel(); };
  }, [visible, page, drawn]);

  const pageVars = { '--total-scale-factor': scale, '--scale-round-x': '1px', '--scale-round-y': '1px' };

  return (
    <div ref={containerRef} className="pdf-page" data-column data-page={page.pageNumber} style={{ width: viewport.width, height: viewport.height, ...pageVars }}>
      {visible && <canvas ref={canvasRef} style={{ width: viewport.width, height: viewport.height }} />}
      <div className="pdf-hl-layer">
        {highlights.map((h) => h.bbox && (
          <div
            key={h.id}
            className={`pdf-hl pdf-hl--${h.color ?? 'amber'}`}
            data-hl={h.id}
            style={{ left: h.bbox.x * scale, top: h.bbox.y * scale, width: h.bbox.width * scale, height: h.bbox.height * scale }}
          />
        ))}
      </div>
      {visible && <div ref={textDivRef} className="pdf-text-layer" />}
    </div>
  );
}
