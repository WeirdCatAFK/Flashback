/**
 * YoutubeRenderer — an embedded video with timestamp markers and an optional
 * transcript. The player is proxied through the API's embed page and driven over
 * postMessage (useYoutubePlayer.js); the document, markers and transcript live in
 * useYoutubeDocument.js. Capabilities are declared in ../registry.js.
 */

import { useState, useRef } from 'react';
import { setYoutubeSource } from '../../../../api/documents';
import { youtubeEmbedUrl } from '../../../../api/embed';
import SourceUrlForm from '../SourceUrlForm';
import { useT } from '../../../../translations/index';
import { formatTime } from './time.js';
import useYoutubePlayer from './useYoutubePlayer';
import useYoutubeDocument from './useYoutubeDocument';
import './YoutubeRenderer.css';
import '../Renderer.css';

function TranscriptPanel({ cues, onSeek, onMark }) {
  const { t } = useT();
  return (
    <div className="yt-transcript-panel">
      <ul className="yt-transcript-lines">
        {cues.map((c, i) => (
          <li key={`${c.start}-${i}`} className="yt-transcript-line">
            <button type="button" className="yt-transcript-time" onClick={() => onSeek(c.start ?? 0)} title={t('Jump the player here')}>
              {formatTime(c.start ?? 0)}
            </button>
            <span className="yt-transcript-text">{c.text}</span>
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => onMark(c.start ?? 0, c.text)}
              aria-label={t('Mark this moment')}
              title={t('Mark this moment as a highlight (its text becomes the card source)')}
            >
              ✚
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TranscriptButton({ transcript, show, fetching, onToggle, onFetch }) {
  const { t } = useT();
  if (!transcript) {
    return (
      <button type="button" className="btn btn--sm" onClick={onFetch} disabled={fetching} title={t('Fetch the video’s captions so its transcript is readable and can be turned into cards')}>
        {fetching ? t('Fetching transcript…') : t('Fetch transcript')}
      </button>
    );
  }
  const auto = transcript.kind === 'asr';
  return (
    <button
      type="button"
      className={`btn btn--sm${show ? ' btn--accent-quiet' : ''}`}
      onClick={onToggle}
      aria-pressed={show}
      title={transcript.lang ? (auto ? t('Language: {lang} (auto-generated)', { lang: transcript.lang }) : t('Language: {lang}', { lang: transcript.lang })) : undefined}
    >
      {auto ? (show ? t('Hide transcript (auto)') : t('Show transcript (auto)')) : (show ? t('Hide transcript') : t('Show transcript'))}
    </button>
  );
}

export default function YoutubeRenderer({
  path, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh, initialProgress, onProgress, progressRef,
}) {
  const { t, tp } = useT();
  const [reloadTick, setReloadTick] = useState(0);
  const seekRef = useRef(null);
  const doc = useYoutubeDocument({ path, reloadTick, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh, seekRef });
  const { meta } = doc;
  const embedSrc = youtubeEmbedUrl(meta?.videoId);
  const player = useYoutubePlayer({ path, embedSrc, initialProgress, onProgress, progressRef, onMarkAt: doc.addMomentAt });
  seekRef.current = player.seekTo;

  if (doc.loading) return <div className="renderer-loading">{t('Loading video…')}</div>;
  if (doc.error) return <div className="renderer-error">{t('Could not load video: {error}', { error: doc.error })}</div>;
  if (!meta?.videoId) {
    return (
      <SourceUrlForm
        title={t('Add a YouTube video')}
        hint={t('Paste a YouTube URL to embed the video here. You can mark timestamps and make cards from them.')}
        placeholder="https://www.youtube.com/watch?v=…"
        submitLabel={t('Load video')}
        busyLabel={t('Loading…')}
        onSubmit={async (url) => {
          await setYoutubeSource(path, url);
          setReloadTick((n) => n + 1);
        }}
      />
    );
  }

  const openLink = meta.url && <a className="yt-source-link" href={meta.url} target="_blank" rel="noreferrer">{t('Open on YouTube ↗')}</a>;

  return (
    <div className="yt-renderer">
      <div className="yt-header">
        <div className="yt-title-row">
          {meta.author && <span className="yt-author">{meta.author}</span>}
        </div>
        {openLink}
      </div>

      <div className="yt-player-wrap">
        {player.apiFailed || !embedSrc ? (
          <div className="yt-offline">
            {meta.thumbnailUrl && <img className="yt-thumb" src={meta.thumbnailUrl} alt="" />}
            <p>{t('Couldn’t load the player.')}{' '}{openLink}</p>
          </div>
        ) : (
          <div className="yt-player">
            <iframe
              ref={player.iframeRef}
              title={meta.title || t('YouTube video')}
              src={embedSrc}
              referrerPolicy="strict-origin-when-cross-origin"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              onError={player.onIframeError}
            />
            {player.playbackError && (
              <div className="yt-playback-error">
                {meta.thumbnailUrl && <img className="yt-thumb" src={meta.thumbnailUrl} alt="" />}
                <p>{player.playbackError.message}</p>
                {openLink}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="toolbar yt-toolbar">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          onClick={player.markMoment}
          disabled={!player.playerReady}
          title={player.playerReady ? t('Capture the current position as a timestamp highlight') : t('Player still loading…')}
        >
          {t('✚ Mark this moment')}
        </button>
        <span className="yt-marker-count">{tp('{n} marker', '{n} markers', doc.highlights.length)}</span>
        <TranscriptButton
          transcript={doc.transcript}
          show={doc.showTranscript}
          fetching={doc.fetchingTranscript}
          onToggle={doc.toggleTranscript}
          onFetch={doc.fetchTranscript}
        />
        {doc.transcriptError && <span className="yt-transcript-error">{doc.transcriptError}</span>}
      </div>

      {doc.showTranscript && doc.transcriptCues.length > 0 && (
        <TranscriptPanel cues={doc.transcriptCues} onSeek={player.seekTo} onMark={doc.addMomentAt} />
      )}

      {doc.highlights.length > 0 && (
        <ul className="yt-markers">
          {doc.highlights.map((h) => (
            <li key={h.id} className={`yt-marker yt-marker--${h.color ?? 'amber'}`} data-hl={h.id}>
              <button type="button" className="yt-marker-time" onClick={() => player.seekTo(h.start ?? 0)}>{formatTime(h.start ?? 0)}</button>
              <span className="yt-marker-label">{h.text || ''}</span>
              <button type="button" className="btn-close yt-marker-remove" onClick={() => doc.removeMoment(h.id)} aria-label={t('Remove marker')} title={t('Remove marker')}>×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
