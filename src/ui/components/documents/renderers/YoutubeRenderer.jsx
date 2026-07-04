import { useState, useEffect, useRef, useCallback } from 'react';
import { readFile, updateMetadata, setYoutubeSource } from '../../../api/documents';
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

// Loads the YouTube IFrame API once for the whole app. Resolves with window.YT.
let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => reject(new Error('Failed to load the YouTube player'));
    document.head.appendChild(tag);
  });
  return ytApiPromise;
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
  const [reloadTick, setReloadTick] = useState(0);

  const pathRef        = useRef(path);
  pathRef.current      = path;
  const highlightsRef  = useRef(highlights);
  highlightsRef.current = highlights;
  const currentHlRef   = useRef(null);
  const loadedPathRef  = useRef(null);
  const playerRef      = useRef(null);
  const mountRef       = useRef(null);

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

  // Create the IFrame player once we have a videoId and the mount node
  useEffect(() => {
    if (!meta?.videoId || !mountRef.current) return;
    let cancelled = false;

    loadYouTubeApi().then((YT) => {
      if (cancelled || !mountRef.current) return;
      playerRef.current = new YT.Player(mountRef.current, {
        videoId: meta.videoId,
        playerVars: { rel: 0, modestbranding: 1 },
        events: { onReady: () => { if (!cancelled) setPlayerReady(true); } },
      });
    }).catch(() => { if (!cancelled) setApiFailed(true); });

    return () => {
      cancelled = true;
      try { playerRef.current?.destroy?.(); } catch { /* ignore */ }
      playerRef.current = null;
    };
  }, [meta?.videoId]);

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
    const p = playerRef.current;
    if (!p?.seekTo) return;
    try { p.seekTo(seconds, true); p.playVideo?.(); } catch { /* ignore */ }
  }, []);

  // Capture the current playback position as a timestamp highlight
  const markMoment = useCallback(() => {
    const p = playerRef.current;
    if (!p?.getCurrentTime) return;
    let t = 0;
    try { t = p.getCurrentTime() || 0; } catch { t = 0; }
    const now = new Date().toISOString();
    const hl = {
      id: generateId(),
      color: 'amber',
      type: 'video_timestamp',
      start: t,
      end: t,
      text: `@ ${formatTime(t)}`,
      createdAt: now, updatedAt: now,
      cardHashes: [], refIds: [],
    };
    const next = [...highlightsRef.current, hl].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    highlightsRef.current = next;
    setHighlights(next);
    handleSaveRef.current?.();
  }, []);

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
        {apiFailed ? (
          <div className="yt-offline">
            {meta.thumbnailUrl && <img className="yt-thumb" src={meta.thumbnailUrl} alt="" />}
            <p>Couldn&apos;t load the player (offline?).{' '}
              {meta.url && <a href={meta.url} target="_blank" rel="noreferrer">Open on YouTube ↗</a>}
            </p>
          </div>
        ) : (
          <div className="yt-player"><div ref={mountRef} /></div>
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
