/**
 * A clip's lifecycle: load the sidecar, paint the body imperatively (so the
 * injected <mark>s survive re-renders), re-apply its highlights, serve the
 * highlight command contract, and save the sidecar on Ctrl+S. Saving is
 * sidecar-only — the clip body is written by saveClipAsset, never here.
 */

import { useState, useEffect, useRef } from 'react';
import { readFile, updateMetadata } from '../../../../api/documents';
import { useT } from '../../../../translations/index';
import { generateHighlightId } from '../highlightId.js';
import { rewriteMedia } from './media.js';
import { applyHighlight, selectionOffsets, wrapOffsets, unwrap, highlightIdAtSelection, recolor } from './clipHighlights.js';

const QUOTE_MAX = 240;

export default function useClipDocument({ path, reloadTick, saveRef, highlightRef, onHighlightsChange, onSidecarRefresh }) {
  const { t } = useT();
  const [source, setSource] = useState(null);
  const [highlights, setHighlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [empty, setEmpty] = useState(false);
  const bodyRef = useRef(null);
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
    setSource(null);
    setAll([]);
    loadedPathRef.current = null;
    let mounted = true;

    readFile(path).then(({ content, metadata }) => {
      if (!mounted) return;
      const hls = metadata?.highlights ?? [];
      const isEmpty = !metadata?.source && !(content && content.trim());
      setSource(metadata?.source ?? null);
      setAll(hls);
      setEmpty(isEmpty);
      loadedPathRef.current = path;
      if (!isEmpty) {
        requestAnimationFrame(() => {
          const root = bodyRef.current;
          if (!root || loadedPathRef.current !== path) return;
          root.innerHTML = content || '';
          rewriteMedia(root, path);
          for (const h of hls) applyHighlight(root, h);
        });
      }
      onHighlightsChange?.(path, hls);
      onSidecarRefresh?.(path, metadata ?? {});
      setLoading(false);
    }).catch((err) => {
      if (!mounted) return;
      setError(err.message ?? t('Failed to load clip'));
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

  useEffect(() => {
    if (!highlightRef) return undefined;
    const removeById = (id) => {
      const root = bodyRef.current;
      if (root) unwrap(root, id);
      setAll(highlightsRef.current.filter((h) => h.id !== id));
      if (currentHlRef.current === id) currentHlRef.current = null;
      return { kind: 'removed', id };
    };
    const commands = {
      toggle: (color) => {
        const root = bodyRef.current;
        if (!root) return null;
        const existingId = highlightIdAtSelection(root);
        if (existingId) {
          const existing = highlightsRef.current.find((h) => h.id === existingId);
          if (existing?.color === color) return { kind: 'existing', id: existingId };
          recolor(root, existingId, color);
          setAll(highlightsRef.current.map((h) => (h.id === existingId ? { ...h, color, updatedAt: new Date().toISOString() } : h)));
          return { kind: 'recolored', id: existingId };
        }
        const off = selectionOffsets(root);
        if (!off) return null;
        const now = new Date().toISOString();
        const id = generateHighlightId();
        const hl = {
          id, color, type: 'clip_range', start: off.start, end: off.end,
          text: off.text.trim().slice(0, QUOTE_MAX), createdAt: now, updatedAt: now, cardHashes: [], refIds: [],
        };
        wrapOffsets(root, off.start, off.end, id, color);
        setAll([...highlightsRef.current, hl]);
        window.getSelection()?.removeAllRanges();
        return { kind: 'created', id };
      },
      unset: () => (currentHlRef.current ? removeById(currentHlRef.current) : null),
      remove: (id) => (id && highlightsRef.current.some((h) => h.id === id) ? removeById(id) : null),
      ensure: (color = 'amber') => {
        const root = bodyRef.current;
        if (!root) return null;
        const existing = highlightIdAtSelection(root);
        if (existing) { currentHlRef.current = existing; return { kind: 'existing', id: existing }; }
        return commands.toggle(color);
      },
      currentId: () => {
        const root = bodyRef.current;
        const id = root ? highlightIdAtSelection(root) : null;
        currentHlRef.current = id;
        return id;
      },
      scrollTo: (id) => {
        const el = bodyRef.current?.querySelector(`mark[data-hl="${id}"]`);
        if (!el) return false;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      },
    };
    highlightRef.current = commands;
    return () => { highlightRef.current = null; };
  });

  return { bodyRef, source, highlights, loading, error, empty };
}
