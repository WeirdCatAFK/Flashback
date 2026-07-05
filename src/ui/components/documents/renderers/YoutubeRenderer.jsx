import { useState, useEffect, useRef, useCallback } from 'react';
import { readFile, updateMetadata, setYoutubeSource } from '../../../api/documents';
import { getBaseUrl } from '../../../api/client';
import SourceUrlForm from './SourceUrlForm';
import './YoutubeRenderer.css';
import './Renderer.css';

function generateId() {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return 'h_' + (rand[0].toString(36) + rand[1].toString(36)).slice(0, 9);
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export default function YoutubeRenderer({
  path,
  saveRef,
  highlightRef,
  onHighlightsChange,
  onSidecarRefresh,
}) {
  const [meta,       setMeta]       = useState(null);   // { videoId, title, author, thumbnailUrl }
  const [highlights, setHighlights] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [playerReady, setPlayerReady] = useState(false);
  const [apiFailed,  setApiFailed]  = useState(false);
  const [playbackError, setPlaybackError] = useState(null); // { code, message } from the embed's onError
  const [reloadTick, setReloadTick] = useState(0);

  const pathRef        = useRef(path);
  pathRef.current      = path;
  const highlightsRef  = useRef(highlights);
  highlightsRef.current = highlights;
  const currentHlRef   = useRef(null);
  const loadedPathRef  = useRef(null);
  const iframeRef      = useRef(null);

  // The player runs inside the /embed/youtube proxy page, which the API serves over
  // the real http://localhost origin so YouTube's post-2025 referrer/origin check
  // passes (a file:// renderer can't provide either — that's the Error 153 cause).
  const embedSrc = meta?.videoId && getBaseUrl()
    ? `${getBaseUrl()}/embed/youtube?v=${encodeURIComponent(meta.videoId)}`
    : null;

  // Load body (JSON descriptor) + sidecar highlights
  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    setMeta(null);
    setHighlights([]);
    highlightsRef.current = [];
    setPlayerReady(false);
    setApiFailed(false);
    setPlaybackError(null);
    loadedPathRef.current = null;
    let mounted = true;

    readFile(path).then(({ content, metadata }) => {
      if (!mounted) return;
      let body = {};
      try { body = JSON.parse(content || '{}'); } catch { body = {}; }
      const hls = metadata?.highlights ?? [];
      setMeta({
        videoId:      body.videoId || metadata?.source?.videoId || '',
        title:        body.title || metadata?.source?.title || '',
        author:       body.author || '',
        url:          body.url || metadata?.source?.url || '',
        thumbnailUrl: body.thumbnailUrl || '',
      });
      setHighlights(hls);
      highlightsRef.current = hls;
      loadedPathRef.current = path;
      onHighlightsChange?.(path, hls);
      onSidecarRefresh?.(path, metadata ?? {});
      setLoading(false);
    }).catch(err => {
      if (!mounted) return;
      setError(err.message ?? 'Failed to load video reference');
      setLoading(false);
    });

    return () => { mounted = false; };
  }, [path, reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Append a timestamp highlight at the given playback position (seconds).
  const addMomentAt = useCallback((seconds) => {
    const now = new Date().toISOString();
    const hl = {
      id: generateId(),
      color: 'amber',
      type: 'video_timestamp',
      start: seconds, end: seconds,
      text: `@ ${formatTime(seconds)}`,
      createdAt: now, updatedAt: now,
      cardHashes: [], refIds: [],
    };
    const next = [...highlightsRef.current, hl].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    highlightsRef.current = next;
    setHighlights(next);
    handleSaveRef.current?.();
  }, []);

  // Bridge to the embed proxy: parent → { cmd } out, iframe → { event } in.
  const postCmd = useCallback((msg) => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'fb-yt-cmd', ...msg }, '*');
  }, []);

  useEffect(() => {
    if (!embedSrc) return;
    setPlayerReady(false);
    setPlaybackError(null);

    function onMessage(ev) {
      // Only trust messages from our own embed iframe.
      if (!iframeRef.current || ev.source !== iframeRef.current.contentWindow) return;
      const d = ev.data;
      if (!d || d.type !== 'fb-yt') return;
      if (d.event === 'ready') {
        setPlayerReady(true);
        setPlaybackError(null);
      } else if (d.event === 'error') {
        const code = d.code;
        // 101/150 = owner disabled embedding (incl. age-restricted / adult content,
        // which YouTube never allows in third-party embeds); 100 = removed/private;
        // 2/5 = bad id / HTML5 error. Surface a link out instead of a dead player.
        const embedBlocked = code === 101 || code === 150;
        setPlaybackError({
          code,
          message: embedBlocked
            ? "This video can't be played in an embed (the owner disabled embedding, or it's age-restricted). Open it on YouTube instead."
            : 'This video is unavailable (it may be private or removed).',
        });
      } else if (d.event === 'markAt') {
        addMomentAt(d.seconds || 0);
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [embedSrc, addMomentAt]);

  // Save: sidecar only (the .youtube body is immutable)
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async () => {
    const savedPath = pathRef.current;
    if (loadedPathRef.current !== savedPath) return;
    try {
      let baseMeta = {};
      try { baseMeta = (await readFile(savedPath)).metadata ?? {}; } catch { /* ok */ }
      const nextMeta = { ...baseMeta, highlights: highlightsRef.current };
      await updateMetadata(savedPath, nextMeta);
      onHighlightsChange?.(savedPath, highlightsRef.current);
      onSidecarRefresh?.(savedPath, nextMeta);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (saveRef) saveRef.current = () => handleSaveRef.current?.();
    return () => { if (saveRef) saveRef.current = null; };
  });

  const seekTo = useCallback((seconds) => {
    postCmd({ cmd: 'seek', seconds });
  }, [postCmd]);

  // Ask the player for its current position; addMomentAt runs when it answers.
  const markMoment = useCallback(() => {
    if (!playerReady) return;
    postCmd({ cmd: 'mark' });
  }, [playerReady, postCmd]);

  const removeMoment = useCallback((id) => {
    const next = highlightsRef.current.filter(h => h.id !== id);
    highlightsRef.current = next;
    setHighlights(next);
    if (currentHlRef.current === id) currentHlRef.current = null;
    handleSaveRef.current?.();
  }, []);

  // highlightRef command contract. There is no text selection on a video, so
  // toggle is a no-op; moments are created via the "Mark this moment" button.
  // scrollTo seeks the player to the highlight's timestamp.
  useEffect(() => {
    if (!highlightRef) return;
    highlightRef.current = {
      toggle: () => null,
      unset: () => {
        const id = currentHlRef.current;
        if (!id) return null;
        removeMoment(id);
        return { kind: 'removed', id };
      },
      ensure: () => (currentHlRef.current ? { kind: 'existing', id: currentHlRef.current } : null),
      currentId: () => currentHlRef.current,
      scrollTo: (id) => {
        const hl = highlightsRef.current.find(h => h.id === id);
        if (!hl) return false;
        currentHlRef.current = id;
        seekTo(hl.start ?? 0);
        const el = document.querySelector(`.yt-marker[data-hl="${id}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return true;
      },
    };
    return () => { if (highlightRef) highlightRef.current = null; };
  });

  if (loading) return <div className="renderer-loading">Loading video…</div>;
  if (error)   return <div className="renderer-error">Could not load video: {error}</div>;
  if (!meta?.videoId) {
    return (
      <SourceUrlForm
        title="Add a YouTube video"
        hint="Paste a YouTube URL to embed the video here. You can mark timestamps and make cards from them."
        placeholder="https://www.youtube.com/watch?v=…"
        submitLabel="Load video"
        busyLabel="Loading…"
        onSubmit={async (url) => {
          await setYoutubeSource(path, url);
          setReloadTick((t) => t + 1);
        }}
      />
    );
  }

  return (
    <div className="yt-renderer">
      <div className="yt-header">
        <div className="yt-title-row">
          <span className="yt-title">{meta.title || 'YouTube video'}</span>
          {meta.author && <span className="yt-author">{meta.author}</span>}
        </div>
        {meta.url && (
          <a className="yt-source-link" href={meta.url} target="_blank" rel="noreferrer">Open on YouTube ↗</a>
        )}
      </div>

      <div className="yt-player-wrap">
        {apiFailed || !embedSrc ? (
          <div className="yt-offline">
            {meta.thumbnailUrl && <img className="yt-thumb" src={meta.thumbnailUrl} alt="" />}
            <p>Couldn&apos;t load the player.{' '}
              {meta.url && <a href={meta.url} target="_blank" rel="noreferrer">Open on YouTube ↗</a>}
            </p>
          </div>
        ) : (
          <div className="yt-player">
            <iframe
              ref={iframeRef}
              title={meta.title || 'YouTube video'}
              src={embedSrc}
              referrerPolicy="strict-origin-when-cross-origin"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              onError={() => setApiFailed(true)}
            />
            {playbackError && (
              <div className="yt-playback-error">
                {meta.thumbnailUrl && <img className="yt-thumb" src={meta.thumbnailUrl} alt="" />}
                <p>{playbackError.message}</p>
                {meta.url && (
                  <a className="yt-source-link" href={meta.url} target="_blank" rel="noreferrer">
                    Open on YouTube ↗
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="yt-toolbar">
        <button
          type="button"
          className="yt-mark-btn"
          onClick={markMoment}
          disabled={!playerReady}
          title={playerReady ? 'Capture the current position as a timestamp highlight' : 'Player still loading…'}
        >
          ✚ Mark this moment
        </button>
        <span className="yt-marker-count">{highlights.length} marker{highlights.length === 1 ? '' : 's'}</span>
      </div>

      {highlights.length > 0 && (
        <ul className="yt-markers">
          {highlights.map(h => (
            <li key={h.id} className={`yt-marker yt-marker--${h.color ?? 'amber'}`} data-hl={h.id}>
              <button type="button" className="yt-marker-time" onClick={() => seekTo(h.start ?? 0)}>
                {formatTime(h.start ?? 0)}
              </button>
              <span className="yt-marker-label">{h.text || ''}</span>
              <button
                type="button"
                className="yt-marker-remove"
                onClick={() => removeMoment(h.id)}
                aria-label="Remove marker"
                title="Remove marker"
              >×</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

YoutubeRenderer.supportsHighlight = true;
