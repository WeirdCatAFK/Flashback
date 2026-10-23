/**
 * PdfRenderer — a PDF as a scroll of lazily rendered pages, text-selection
 * highlights and a box-draw mode for scanned pages. Its tools (zoom, Fit width,
 * Box highlight) are portaled into the reading strip's `toolsTarget`, so the
 * document has one bar above it rather than a strip and a toolbar. The zoom
 * percentage is a field: type any value in range and Enter (or leave it) applies
 * it, Esc puts back the current one. Capabilities
 * are declared in ../registry.js; the lifecycle is usePdfDocument.js and the
 * highlight logic usePdfHighlights.js.
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../../../translations/index';
import { SCALE_MIN, SCALE_MAX, scaleFromPercent } from './geometry.js';
import PdfPage from './PdfPage';
import usePdfDocument from './usePdfDocument';
import usePdfHighlights from './usePdfHighlights';
import './PdfRenderer.css';
import '../Renderer.css';

const MinusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <line x1="3" y1="7" x2="11" y2="7" />
  </svg>
);
const PlusIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <line x1="3" y1="7" x2="11" y2="7" />
    <line x1="7" y1="3" x2="7" y2="11" />
  </svg>
);
const FitIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <line x1="1.5" y1="2.5" x2="1.5" y2="11.5" />
    <line x1="12.5" y1="2.5" x2="12.5" y2="11.5" />
    <path d="M4 7h6M4 7l2-2M4 7l2 2M10 7l-2-2M10 7l-2 2" />
  </svg>
);
const BoxIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="3" width="10" height="8" rx="1" strokeDasharray="2.5 2" />
  </svg>
);

/** The zoom percentage as a field; `draft` is what is typed until it is applied or dropped. */
function ZoomField({ scale, onZoom, label }) {
  const [draft, setDraft] = useState(null);
  const apply = () => {
    const next = draft === null ? null : scaleFromPercent(draft);
    if (next) onZoom(next);
    setDraft(null);
  };
  return (
    <label className="pdf-zoom-label">
      <input
        className="pdf-zoom-input"
        inputMode="numeric"
        aria-label={label}
        value={draft ?? String(Math.round(scale * 100))}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply();
          else if (e.key === 'Escape') setDraft(null);
        }}
      />
      %
    </label>
  );
}

export default function PdfRenderer({
  path, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh, initialProgress, onProgress, progressRef, toolsTarget,
}) {
  const { t, tp } = useT();
  const doc = usePdfDocument({ path, saveRef, onHighlightsChange, onSidecarRefresh, initialProgress, onProgress, progressRef });
  const { pages, highlights, loading, error, scale } = doc;
  const hl = usePdfHighlights({ highlightRef, highlightsRef: doc.highlightsRef, setAll: doc.setAll, pages, pagesRef: doc.pagesRef, scale, save: doc.save });

  if (loading) return <div className="renderer-loading">{t('Loading PDF…')}</div>;
  if (error) return <div className="renderer-error">{t('Could not load PDF: {error}', { error })}</div>;

  return (
    <div className={`pdf-renderer${hl.drawMode ? ' pdf-renderer--draw' : ''}`} ref={doc.rendererRef}>
      {toolsTarget && createPortal(<span className="pdf-tools">
        <div className="pdf-zoom-group" role="group" aria-label={t('Zoom')}>
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={doc.zoomOut} disabled={scale <= SCALE_MIN} title={t('Zoom out')} aria-label={t('Zoom out')}>
            <MinusIcon />
          </button>
          <ZoomField scale={scale} onZoom={doc.zoomTo} label={t('Zoom percentage')} />
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={doc.zoomIn} disabled={scale >= SCALE_MAX} title={t('Zoom in')} aria-label={t('Zoom in')}>
            <PlusIcon />
          </button>
        </div>

        <button type="button" className="btn btn--ghost btn--sm" onClick={doc.fitWidth} title={t('Zoom so a page fills the width')}>
          <FitIcon />
          {t('Fit width')}
        </button>

        <div className="divider-v" aria-hidden="true" />

        <button
          type="button"
          className={`btn btn--sm${hl.drawMode ? ' btn--accent-quiet' : ' btn--ghost'}`}
          onClick={hl.toggleDrawMode}
          aria-pressed={hl.drawMode}
          title={hl.drawMode ? t('Stop drawing highlight boxes') : t('Draw a highlight box — for scanned PDFs where text can’t be selected')}
        >
          <BoxIcon />
          {t('Box highlight')}
        </button>

        <span className="pdf-toolbar-pages">{tp('{n} page', '{n} pages', pages.length)}</span>
      </span>, toolsTarget)}
      {hl.drawMode && <div className="pdf-draw-hint">{t('Drag on a page to mark a region · Esc cancels')}</div>}

      <div className="pdf-pages" ref={doc.pagesRef}>
        {pages.map((page) => (
          <PdfPage key={page.pageNumber} page={page} scale={scale} highlights={highlights.filter((h) => h.page === page.pageNumber)} />
        ))}
      </div>

      <div ref={hl.overlayRef} className="pdf-draw-rect" style={{ display: 'none' }} />
    </div>
  );
}
