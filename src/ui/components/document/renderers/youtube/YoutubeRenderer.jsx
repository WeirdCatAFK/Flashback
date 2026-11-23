import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { setYoutubeSource } from '../../../../api/documents';
import { youtubeEmbedUrl } from '../../../../api/embed';
import SourceUrlForm from '../SourceUrlForm';
import { useT } from '../../../../translations/index';
import { formatTime } from './time.js';
import { paraIndexAt } from './transcript.js';
import useYoutubePlayer from './useYoutubePlayer';
import useYoutubeDocument from './useYoutubeDocument';
import useFloatingPlayer from './useFloatingPlayer';
import VideoBar from './VideoBar';
import VideoText from './VideoText';
import './YoutubeRenderer.css';
import '../Renderer.css';

const FRESH_MS = 900;

export default function YoutubeRenderer({
  path, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh, initialProgress, onProgress, progressRef, toolsTarget,
}) {
  const { t } = useT();
  const [reloadTick, setReloadTick] = useState(0);
  const [freshId, setFreshId] = useState(null);
  const [nowAway, setNowAway] = useState(false);
  const rootRef = useRef(null);
  const textRootRef = useRef(null);
  const slotRef = useRef(null);
  const frameRef = useRef(null);
  const seekRef = useRef(null);
  const doc = useYoutubeDocument({ path, reloadTick, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh, seekRef, textRootRef });
  const { meta } = doc;
  const embedSrc = youtubeEmbedUrl(meta?.videoId);
  const onMarkAt = (seconds) => {
    const id = doc.addMomentAt(seconds);
    setFreshId(id);
    setTimeout(() => setFreshId((f) => (f === id ? null : f)), FRESH_MS);
  };
  const player = useYoutubePlayer({ path, embedSrc, initialProgress, onProgress, progressRef, onMarkAt });
  seekRef.current = player.seekTo;
  const float = useFloatingPlayer({ slotRef, frameRef, playing: player.playing, enabled: !doc.loading && !!embedSrc });

  const hasTranscript = doc.paras.length > 0;
  const lastCue = doc.transcriptCues.at?.(-1);
  const duration = player.duration || (lastCue ? (Number(lastCue.start) || 0) + (Number(lastCue.dur) || 0) : 0);
  const notes = hasTranscript ? doc.placement.loose : doc.highlights;
  const nowKey = hasTranscript
    ? (() => { const i = paraIndexAt(doc.paras, player.time); const note = doc.placement.loose.filter((n) => (n.start ?? 0) <= player.time).at(-1); return note && (note.start ?? 0) > (doc.paras[i]?.start ?? -1) ? note.id : i >= 0 ? `p${i}` : null; })()
    : [...notes].sort((a, b) => (a.start ?? 0) - (b.start ?? 0)).filter((n) => (n.start ?? 0) <= player.time).at(-1)?.id ?? null;

  const markRef = useRef(player.markMoment);
  markRef.current = player.markMoment;
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key !== 'm' && e.key !== 'M') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (!rootRef.current?.offsetParent) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      markRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const root = textRootRef.current;
    const sc = root?.closest('.doc-editor-renderer');
    if (!root || !sc) return undefined;
    const check = () => {
      const now = root.querySelector('.yt-para.is-now');
      if (!now) { setNowAway(false); return; }
      const r = now.getBoundingClientRect(), s = sc.getBoundingClientRect();
      setNowAway(r.bottom < s.top + 60 || r.top > s.bottom);
    };
    check();
    sc.addEventListener('scroll', check, { passive: true });
    return () => sc.removeEventListener('scroll', check);
  }, [nowKey, doc.paras, doc.highlights]);

  if (doc.loading) return <div className="renderer-loading">{t('Loading video…')}</div>;
  if (doc.error) return <div className="renderer-error">{t('Could not load video: {error}', { error: doc.error })}</div>;
  if (!meta?.videoId) {
    return (
      <SourceUrlForm
        title={t('Add a YouTube video')}
        hint={t('Paste a YouTube URL to embed the video here. You can mark moments and make cards from them.')}
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

  const openLink = meta.url && <a className="yt-source__link" href={meta.url} target="_blank" rel="noreferrer">{t('Open on YouTube ↗')}</a>;
  const jump = (id) => {
    const h = doc.highlights.find((x) => x.id === id);
    if (!h) return;
    player.seekTo(h.start ?? 0, { play: player.playing });
    textRootRef.current?.querySelector(`mark[data-hl="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className={`yt-renderer${duration >= 3600 ? ' is-hours' : ''}`} ref={rootRef}>
      {toolsTarget && createPortal(
        <button
          type="button"
          className="doc-reading-action yt-mark"
          onClick={player.markMoment}
          disabled={!player.playerReady}
          title={hasTranscript ? t('Highlight the line being said now') : t('Add a note at this moment')}
        >
          {t('Mark moment')} <kbd>M</kbd>
        </button>,
        toolsTarget,
      )}

      <div className="yt-source">
        {meta.author && <span>{meta.author}</span>}
        {duration > 0 && <span className="yt-source__length">{formatTime(duration)}</span>}
        {openLink}
      </div>

      <div className="yt-player-slot" ref={slotRef}>
        {player.apiFailed || !embedSrc ? (
          <div className="yt-offline">
            {meta.thumbnailUrl && <img className="yt-thumb" src={meta.thumbnailUrl} alt="" />}
            <p>{t('Couldn’t load the player.')}{' '}{openLink}</p>
          </div>
        ) : (
          <div
            ref={frameRef}
            className={`yt-player${float.floating ? ' is-floating' : ''}${float.dragging ? ' is-dragging' : ''}${float.settling ? ' is-settling' : ''}`}
            style={float.style}
          >
            <div className="yt-mini-bar" {...float.handleProps} title={t('Drag to move it to another corner')}>
              <button type="button" className="yt-mini-bar__btn" onClick={float.back}>{t('Back to the video')}</button>
              <button type="button" className="yt-mini-bar__btn" onClick={float.close} aria-label={t('Close the small player')} title={t('Close the small player')}>×</button>
            </div>
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

      <VideoBar
        ready={player.playerReady}
        playing={player.playing}
        time={player.time}
        duration={duration}
        moments={doc.highlights}
        freshId={freshId}
        onToggle={player.togglePlay}
        onSeek={player.seekTo}
        onJump={jump}
        showNow={nowAway}
        onBackToNow={() => textRootRef.current?.querySelector('.yt-para.is-now')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
      />

      <VideoText
        rootRef={textRootRef}
        paras={doc.paras}
        placement={doc.placement}
        notes={notes}
        nowKey={nowKey}
        composing={doc.composing}
        transcript={doc.transcript}
        fetching={doc.fetchingTranscript}
        fetchError={doc.transcriptError}
        onSeek={(s) => player.seekTo(s)}
        onEdit={doc.setComposing}
        onNoteDone={doc.setNoteText}
        onFetch={doc.fetchTranscript}
      />
    </div>
  );
}
