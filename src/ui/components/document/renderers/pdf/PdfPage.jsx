/**
 * PdfPage — one page: a canvas rendered lazily when it scrolls near the
 * viewport, the highlight boxes over it, and pdf.js's text layer for selection.
 * The `--total-scale-factor` / `--scale-round-*` variables are what pdfjs-dist
 * v6's TextLayer reads to size its spans.
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { TextLayer } from 'pdfjs-dist';

const PRELOAD_MARGIN = '200px';

export default function PdfPage({ page, scale, highlights }) {
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const textDivRef = useRef(null);
  const [visible, setVisible] = useState(false);

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
    canvas.width = viewport.width * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const task = page.render({ canvasContext: ctx, viewport });
    task.promise.catch(() => {});
    return () => task.cancel();
  }, [visible, page, viewport]);

  useEffect(() => {
    if (!visible || !textDivRef.current) return undefined;
    const div = textDivRef.current;
    div.innerHTML = '';
    let layer = null;
    let cancelled = false;
    page.getTextContent().then((tc) => {
      if (cancelled) return undefined;
      layer = new TextLayer({ textContentSource: tc, container: div, viewport });
      return layer.render();
    }).catch(() => {});
    return () => { cancelled = true; layer?.cancel(); };
  }, [visible, page, viewport]);

  const pageVars = { '--total-scale-factor': scale, '--scale-round-x': '1px', '--scale-round-y': '1px' };

  return (
    <div ref={containerRef} className="pdf-page" data-column data-page={page.pageNumber} style={{ width: viewport.width, height: viewport.height, ...pageVars }}>
      {visible && <canvas ref={canvasRef} />}
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
