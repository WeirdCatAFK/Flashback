/**
 * A `.youtube` document: the video record and its sidecar, the timestamp
 * markers (each a `video_timestamp` highlight, saved as soon as it is made), the
 * fetched transcript, and the highlight command contract — which for a video
 * is remove / current / scroll-to, since a mark is made from the player.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { readFile, updateMetadata, fetchYoutubeTranscript } from '../../../../api/documents';
import { useT } from '../../../../translations/index';
import { parseVideoMeta, transcriptFrom, newMarker, withMarker } from './player.js';

export default function useYoutubeDocument({ path, reloadTick, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh, seekRef }) {
  const { t } = useT();
  const [meta, setMeta] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [transcriptCues, setTranscriptCues] = useState([]);
  const [fetchingTranscript, setFetchingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const pathRef = useRef(path);
  pathRef.current = path;
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const currentHlRef = useRef(null);
  const loadedPathRef = useRef(null);

  const setAll = (next) => { highlightsRef.current = next; setHighlights(next); };

  useEffect(() => {
    if (!path) return undefined;
    setLoading(true);
    setError(null);
    setMeta(null);
    setAll([]);
    setTranscript(null);
    setTranscriptCues([]);
    setTranscriptError(null);
    setShowTranscript(false);
    loadedPathRef.current = null;
    let mounted = true;
    readFile(path).then(({ content, metadata }) => {
      if (!mounted) return;
      const hls = metadata?.highlights ?? [];
      setMeta(parseVideoMeta(content, metadata));
      setAll(hls);
      const tr = transcriptFrom(metadata);
      setTranscriptCues(tr.cues);
      setTranscript(tr.info);
      loadedPathRef.current = path;
      onHighlightsChange?.(path, hls);
      onSidecarRefresh?.(path, metadata ?? {});
      setLoading(false);
    }).catch((err) => {
      if (!mounted) return;
      setError(err.message ?? t('Failed to load video reference'));
      setLoading(false);
    });
    return () => { mounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadTick]);

  const saveHandlerRef = useRef(null);
  saveHandlerRef.current = async () => {
    const savedPath = pathRef.current;
    if (loadedPathRef.current !== savedPath) return;
    try {
      let baseMeta = {};
      try { baseMeta = (await readFile(savedPath)).metadata ?? {}; } catch { }
      const nextMeta = { ...baseMeta, highlights: highlightsRef.current };
      await updateMetadata(savedPath, nextMeta);
      onHighlightsChange?.(savedPath, highlightsRef.current);
      onSidecarRefresh?.(savedPath, nextMeta);
    } catch { }
  };
  useEffect(() => {
    if (saveRef) saveRef.current = () => saveHandlerRef.current?.();
    return () => { if (saveRef) saveRef.current = null; };
  });

  const addMomentAt = useCallback((seconds, label) => {
    setAll(withMarker(highlightsRef.current, newMarker(seconds, label)));
    saveHandlerRef.current?.();
  }, []);

  const removeMoment = useCallback((id) => {
    setAll(highlightsRef.current.filter((h) => h.id !== id));
    if (currentHlRef.current === id) currentHlRef.current = null;
    saveHandlerRef.current?.();
  }, []);

  const fetchTranscript = useCallback(async () => {
    const target = pathRef.current;
    if (!target) return;
    setFetchingTranscript(true);
    setTranscriptError(null);
    try {
      const res = await fetchYoutubeTranscript(target);
      let cues = [];
      try { cues = (await readFile(target)).metadata?.source?.transcript ?? []; } catch { }
      if (pathRef.current === target) {
        setTranscript({ cues: res.cues, lang: res.lang, kind: res.kind });
        setTranscriptCues(Array.isArray(cues) ? cues : []);
        setShowTranscript(true);
      }
    } catch (err) {
      if (pathRef.current === target) setTranscriptError(err?.message || t('This video has no captions to transcribe.'));
    } finally {
      if (pathRef.current === target) setFetchingTranscript(false);
    }
  }, [t]);

  useEffect(() => {
    if (!highlightRef) return undefined;
    highlightRef.current = {
      toggle: () => null,
      unset: () => {
        const id = currentHlRef.current;
        if (!id) return null;
        removeMoment(id);
        return { kind: 'removed', id };
      },
      remove: (id) => {
        if (!id || !highlightsRef.current.some((h) => h.id === id)) return null;
        setAll(highlightsRef.current.filter((h) => h.id !== id));
        if (currentHlRef.current === id) currentHlRef.current = null;
        return { kind: 'removed', id };
      },
      ensure: () => (currentHlRef.current ? { kind: 'existing', id: currentHlRef.current } : null),
      currentId: () => currentHlRef.current,
      scrollTo: (id) => {
        const hl = highlightsRef.current.find((h) => h.id === id);
        if (!hl) return false;
        currentHlRef.current = id;
        seekRef?.current?.(hl.start ?? 0);
        document.querySelector(`.yt-marker[data-hl="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return true;
      },
    };
    return () => { highlightRef.current = null; };
  });

  return {
    meta, highlights, loading, error,
    transcript, transcriptCues, fetchingTranscript, transcriptError, showTranscript,
    toggleTranscript: () => setShowTranscript((v) => !v),
    fetchTranscript, addMomentAt, removeMoment,
  };
}
