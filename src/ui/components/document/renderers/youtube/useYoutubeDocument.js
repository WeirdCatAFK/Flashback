import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { mergeMetadata, readFile, fetchYoutubeTranscript } from '../../../../api/documents';
import { useT } from '../../../../translations/index';
import { parseVideoMeta, transcriptFrom, newMarker, withMarker } from './player.js';
import { groupCues, placeHighlights, paraIndexAt, cueAt, timeAtOffset, rangeOverlapping } from './transcript.js';
import { formatTime } from './time.js';

const SAME_MOMENT = 2;

function textOffset(el, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  return r.toString().length;
}

function selectionInTranscript(root) {
  const sel = window.getSelection();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const elementOf = (n) => (n?.nodeType === 1 ? n : n?.parentElement);
  const startEl = elementOf(range.startContainer)?.closest?.('[data-para]');
  if (!startEl || !root.contains(startEl)) return null;
  const endEl = elementOf(range.endContainer)?.closest?.('[data-para]');
  const text = startEl.textContent;
  let from = textOffset(startEl, range.startContainer, range.startOffset);
  let to = endEl === startEl ? textOffset(startEl, range.endContainer, range.endOffset) : text.length;
  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  return to > from ? { index: Number(startEl.dataset.para), from, to } : null;
}

export default function useYoutubeDocument({ path, reloadTick, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh, seekRef, textRootRef }) {
  const { t } = useT();
  const [meta, setMeta] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [transcriptCues, setTranscriptCues] = useState([]);
  const [fetchingTranscript, setFetchingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState(null);
  const [composing, setComposing] = useState(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const currentHlRef = useRef(null);
  const loadedPathRef = useRef(null);

  const paras = useMemo(() => groupCues(transcriptCues), [transcriptCues]);
  const placement = useMemo(() => placeHighlights(paras, highlights), [paras, highlights]);
  const parasRef = useRef(paras);
  parasRef.current = paras;
  const placementRef = useRef(placement);
  placementRef.current = placement;

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
    setComposing(null);
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
      const nextMeta = await mergeMetadata(savedPath, (meta) => ({ ...meta, highlights: highlightsRef.current }));
      onHighlightsChange?.(savedPath, highlightsRef.current);
      onSidecarRefresh?.(savedPath, nextMeta);
    } catch { }
  };
  useEffect(() => {
    if (saveRef) saveRef.current = () => saveHandlerRef.current?.();
    return () => { if (saveRef) saveRef.current = null; };
  });

  const addMomentAt = useCallback((seconds) => {
    const ps = parasRef.current;
    if (ps.length) {
      const i = paraIndexAt(ps, seconds);
      const para = ps[Math.max(0, i)];
      const cue = cueAt(para, seconds);
      const covering = rangeOverlapping(placementRef.current.ranges.get(Math.max(0, i)), cue.offset, cue.offset + cue.length);
      if (covering) return covering.id;
      const marker = newMarker(cue.start, para.text.slice(cue.offset, cue.offset + cue.length));
      setAll(withMarker(highlightsRef.current, marker));
      saveHandlerRef.current?.();
      return marker.id;
    }
    const near = highlightsRef.current.find((h) => Math.abs((h.start ?? 0) - seconds) <= SAME_MOMENT);
    if (near) { setComposing(near.id); return near.id; }
    const marker = newMarker(Math.floor(seconds));
    setAll(withMarker(highlightsRef.current, marker));
    setComposing(marker.id);
    saveHandlerRef.current?.();
    return marker.id;
  }, []);

  const setNoteText = useCallback((id, text) => {
    setComposing(null);
    const h = highlightsRef.current.find((x) => x.id === id);
    if (!h) return;
    const next = text.trim() || `@ ${formatTime(h.start ?? 0)}`;
    if (next === h.text) return;
    setAll(highlightsRef.current.map((x) => (x.id === id ? { ...x, text: next, updatedAt: new Date().toISOString() } : x)));
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
      }
    } catch (err) {
      if (pathRef.current === target) setTranscriptError(err?.message || t('This video has no captions to transcribe.'));
    } finally {
      if (pathRef.current === target) setFetchingTranscript(false);
    }
  }, [t]);

  useEffect(() => {
    if (!highlightRef) return undefined;
    const now = () => new Date().toISOString();
    const fromSelection = (color, recolorExisting) => {
      const hit = selectionInTranscript(textRootRef?.current);
      if (!hit) return null;
      const para = parasRef.current[hit.index];
      if (!para) return null;
      const existing = rangeOverlapping(placementRef.current.ranges.get(hit.index), hit.from, hit.to);
      if (existing) {
        currentHlRef.current = existing.id;
        if (!recolorExisting || existing.color === color) return { kind: 'existing', id: existing.id };
        setAll(highlightsRef.current.map((h) => (h.id === existing.id ? { ...h, color, updatedAt: now() } : h)));
        return { kind: 'recolored', id: existing.id };
      }
      const marker = { ...newMarker(timeAtOffset(para, hit.from), para.text.slice(hit.from, hit.to)), color };
      setAll(withMarker(highlightsRef.current, marker));
      currentHlRef.current = marker.id;
      return { kind: 'created', id: marker.id };
    };
    highlightRef.current = {
      toggle: (color) => fromSelection(color, true),
      ensure: (color = 'amber') => fromSelection(color, false),
      unset: () => {
        const id = fromSelection('amber', false)?.id ?? currentHlRef.current;
        if (!id) return null;
        setAll(highlightsRef.current.filter((h) => h.id !== id));
        return { kind: 'removed', id };
      },
      remove: (id) => {
        if (!id || !highlightsRef.current.some((h) => h.id === id)) return null;
        setAll(highlightsRef.current.filter((h) => h.id !== id));
        if (currentHlRef.current === id) currentHlRef.current = null;
        return { kind: 'removed', id };
      },
      recolor: (id, color) => {
        const h = highlightsRef.current.find((x) => x.id === id);
        if (!h || h.color === color) return null;
        setAll(highlightsRef.current.map((x) => (x.id === id ? { ...x, color, updatedAt: now() } : x)));
        return { kind: 'recolored', id };
      },
      currentId: () => {
        const hit = selectionInTranscript(textRootRef?.current);
        if (hit) currentHlRef.current = rangeOverlapping(placementRef.current.ranges.get(hit.index), hit.from, hit.to)?.id ?? null;
        return currentHlRef.current;
      },
      scrollTo: (id) => {
        const hl = highlightsRef.current.find((h) => h.id === id);
        if (!hl) return false;
        currentHlRef.current = id;
        seekRef?.current?.(hl.start ?? 0, { play: false });
        textRootRef?.current?.querySelector(`mark[data-hl="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      },
    };
    return () => { highlightRef.current = null; };
  });

  return {
    meta, highlights, loading, error,
    transcript, transcriptCues, paras, placement, fetchingTranscript, transcriptError,
    composing, setComposing,
    fetchTranscript, addMomentAt, setNoteText, removeMoment,
  };
}
