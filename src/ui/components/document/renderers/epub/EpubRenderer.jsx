/**
 * EpubRenderer — a paginated book with a page/font toolbar, CFI-anchored
 * highlights and a "make a card" button over a clicked figure. Standalone
 * rather than built on useHighlightableRenderer because the body lives in an
 * iframe epub.js owns. Capabilities are declared in ../registry.js; the
 * lifecycle is useEpubBook.js and the highlights useEpubHighlights.js.
 */

import { useEffect, useRef } from 'react';
import { layoutViewport } from '../../../../utils/uiZoom';
import { useT } from '../../../../translations/index';
import { FONT_MIN, FONT_MAX, FONT_STEP } from './epubTheme.js';
import { imageActionPosition } from './geometry.js';
import useEpubBook from './useEpubBook';
import useEpubHighlights from './useEpubHighlights';
import './EpubRenderer.css';
import '../Renderer.css';

export default function EpubRenderer({
  path, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh, onExternalSelection, onImagePick, initialProgress, onProgress, progressRef, readingBar,
}) {
  const { t } = useT();
  const hl = useEpubHighlights({ highlightRef });
  const book = useEpubBook({
    path, saveRef, onHighlightsChange, onSidecarRefresh, onExternalSelection, initialProgress, onProgress, progressRef,
    highlightsRef: hl.highlightsRef, setAll: hl.setAll, onSelection: hl.onSelection, onMarkClicked: hl.onMarkClicked,
  });
  const onImagePickRef = useRef(onImagePick);
  onImagePickRef.current = onImagePick;

  const { attach } = hl;
  useEffect(() => { attach(book.renditionRef.current, book.ready); }, [attach, book.renditionRef, book.ready]);

  const { imageHit } = book;
  return (
    <div className="epub-renderer">
      <div className="toolbar epub-toolbar">
        <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={book.goPrev} disabled={book.atStart} title={t('Previous page')}>‹</button>
        <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={book.goNext} disabled={book.atEnd} title={t('Next page')}>›</button>
        <span className="epub-progress">{book.progress != null ? `${book.progress}%` : ''}</span>
        <div className="epub-toolbar-spacer" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => book.changeFont(-FONT_STEP)} disabled={book.fontPct <= FONT_MIN} title={t('Smaller text')}>A−</button>
        <span className="epub-font-label">{book.fontPct}%</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => book.changeFont(FONT_STEP)} disabled={book.fontPct >= FONT_MAX} title={t('Larger text')}>A+</button>
        {readingBar}
      </div>

      <div className="epub-viewport-wrap">
        <div ref={book.viewportRef} className="epub-viewport" />
        {book.loading && <div className="renderer-loading epub-overlay">{t('Loading EPUB…')}</div>}
        {book.error && <div className="renderer-error epub-overlay">{t('Could not load EPUB: {error}', { error: book.error })}</div>}
        {imageHit && (
          <button
            type="button"
            className="btn btn--primary btn--sm epub-image-action"
            style={imageActionPosition(imageHit.rect, layoutViewport().height)}
            onClick={() => {
              onImagePickRef.current?.({ href: imageHit.href, name: imageHit.name, alt: imageHit.alt });
              book.dismissImage();
            }}
          >
            {t('Make a card from this image')}
          </button>
        )}
      </div>
    </div>
  );
}
