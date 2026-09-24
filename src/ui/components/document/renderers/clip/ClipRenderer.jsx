/**
 * ClipRenderer — a captured web page: its source line, the readable body with
 * highlights, and the hover-to-save button over pictures and sounds. Capabilities
 * are declared in ../registry.js; the lifecycle lives in useClipDocument.js.
 */

import { useState, useRef } from 'react';
import { setClipSource } from '../../../../api/documents';
import SourceUrlForm from '../SourceUrlForm';
import { useScrollProgress } from '../useScrollProgress';
import { useT } from '../../../../translations/index';
import useClipDocument from './useClipDocument';
import useClipMediaActions from './useClipMediaActions';
import { actionPosition } from './media.js';
import './ClipRenderer.css';
import '../Renderer.css';

export default function ClipRenderer({
  path, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh, onImagePick, initialProgress, onProgress, progressRef,
}) {
  const { t } = useT();
  const [reloadTick, setReloadTick] = useState(0);
  const doc = useClipDocument({ path, reloadTick, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh });
  const { bodyRef, source, loading, error, empty } = doc;
  const ready = !loading && !error && !empty;
  const media = useClipMediaActions(bodyRef, ready);
  const onImagePickRef = useRef(onImagePick);
  onImagePickRef.current = onImagePick;

  useScrollProgress({
    elementRef: bodyRef,
    path,
    length: bodyRef.current?.textContent?.length ?? 0,
    ready: !loading && !error,
    initialProgress,
    onProgress,
    progressRef,
  });

  if (loading) return <div className="renderer-loading">{t('Loading clip…')}</div>;
  if (error) return <div className="renderer-error">{t('Could not load clip: {error}', { error })}</div>;
  if (empty) {
    return (
      <SourceUrlForm
        title={t('Clip a web page')}
        hint={t('Paste a URL to fetch a readable snapshot of the page. Its pictures and sound keep loading from the web — hover one to save it to the vault and put it on a card.')}
        placeholder="https://…"
        submitLabel={t('Clip page')}
        busyLabel={t('Clipping…')}
        onSubmit={async (url) => {
          await setClipSource(path, url);
          setReloadTick((n) => n + 1);
        }}
      />
    );
  }

  const { mediaHit } = media;
  return (
    <div className="clip-renderer">
      {source && (
        <div className="clip-meta">
          <div className="clip-meta-sub">
            {source.url && (
              <a className="clip-meta-source" href={source.url} target="_blank" rel="noreferrer">
                {source.siteName || new URL(source.url).hostname} ↗
              </a>
            )}
            {source.clippedAt && (
              <span className="clip-meta-date">{t('Clipped {date}', { date: new Date(source.clippedAt).toLocaleDateString() })}</span>
            )}
          </div>
        </div>
      )}
      <div ref={bodyRef} className="clip-body" data-column />
      {mediaHit && (
        <button
          type="button"
          className="btn btn--primary btn--sm clip-media-action"
          style={actionPosition(mediaHit.rect)}
          onMouseEnter={media.cancelHide}
          onMouseLeave={media.hideSoon}
          onClick={() => {
            onImagePickRef.current?.({ href: mediaHit.href, name: mediaHit.name, alt: mediaHit.alt, kind: mediaHit.kind });
            media.dismiss();
          }}
        >
          {mediaHit.kind === 'audio' ? t('Make a card from this sound') : t('Make a card from this image')}
        </button>
      )}
    </div>
  );
}
