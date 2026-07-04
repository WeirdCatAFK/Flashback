import { useState, useEffect, useRef } from 'react';
import { readFile, updateMetadata, setClipSource } from '../../../api/documents';
import { getBaseUrl, appendToken } from '../../../api/client';
import SourceUrlForm from './SourceUrlForm';
import './ClipRenderer.css';
import './Renderer.css';

function generateId() {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return 'h_' + (rand[0].toString(36) + rand[1].toString(36)).slice(0, 9);
}

// ── DOM text-offset anchoring ────────────────────────────────────────────────
// Highlights on a .clip anchor by character offset into the container's
// textContent (with the quoted text as a re-anchoring fallback), mirroring the
// .txt strategy but over a raw HTML subtree rather than a ProseMirror doc.

function textSegments(root) {
  const segs = [];
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    segs.push({ node: n, start: offset, end: offset + len });
    offset += len;
  }
  return segs;
}

// Char offset of a (textNode, offset) boundary within root, or null if the
// boundary isn't inside a known text node.
function boundaryOffset(segs, node, offsetInNode) {
  for (const s of segs) {
    if (s.node === node) return s.start + offsetInNode;
  }
  return null;
}

function selectionOffsets(root) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const segs = textSegments(root);
  let start = boundaryOffset(segs, range.startContainer, range.startOffset);
  let end   = boundaryOffset(segs, range.endContainer, range.endOffset);
  if (start == null || end == null) return null;
  if (start > end) [start, end] = [end, start];
  if (end <= start) return null;
  return { start, end, text: sel.toString() };
}

// Wrap the character span [start,end) in <mark> tags carrying the highlight id.
// A span crossing element boundaries is wrapped per-text-node (each physical
// mark shares the same data-hl), so multi-paragraph selections work.
function wrapOffsets(root, start, end, id, color) {
  const ops = [];
  for (const s of textSegments(root)) {
    const from = Math.max(start, s.start) - s.start;
    const to   = Math.min(end, s.end) - s.start;
    if (from < to) ops.push({ node: s.node, from, to });
  }
  for (const op of ops) {
    const range = document.createRange();
    range.setStart(op.node, op.from);
    range.setEnd(op.node, op.to);
    const mark = document.createElement('mark');
    mark.setAttribute('data-hl', id);
    mark.setAttribute('data-color', color || 'amber');
    try { range.surroundContents(mark); } catch { /* boundary split — skip */ }
  }
}

// Re-apply one stored highlight to the freshly-rendered container. Verifies the
// offsets against the text snapshot; re-anchors by searching for the quote if
// the offsets drifted, or drops it if the text is gone.
function applyHighlight(root, h) {
  const fullText = root.textContent || '';
  let { start, end } = h;
  const quote = h.text || '';
  if (typeof start !== 'number' || typeof end !== 'number' || fullText.slice(start, end) !== quote) {
    if (!quote) return false;
    const idx = fullText.indexOf(quote);
    if (idx === -1) return false;
    start = idx;
    end = idx + quote.length;
  }
  if (end <= start) return false;
  wrapOffsets(root, start, end, h.id, h.color);
  return true;
}

function unwrap(root, id) {
  root.querySelectorAll(`mark[data-hl="${id}"]`).forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
}

function highlightIdAtSelection(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node = sel.getRangeAt(0).startContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || !root.contains(node)) return null;
  return node.closest?.('mark[data-hl]')?.getAttribute('data-hl') ?? null;
}

// Point cached local images (`./media/<name>`) at the API media endpoint.
function rewriteMedia(root, docPath) {
  root.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src') || '';
    const m = src.match(/^\.?\/?media\/(.+)$/);
    if (m) {
      img.setAttribute(
        'src',
        appendToken(`${getBaseUrl()}/api/media/file?docPath=${encodeURIComponent(docPath)}&name=${encodeURIComponent(m[1])}`),
      );
    }
  });
}

// ── Renderer ─────────────────────────────────────────────────────────────────

export default function ClipRenderer({
  path,
  saveRef,
  highlightRef,
  onHighlightsChange,
  onSidecarRefresh,
}) {
  const [source,     setSource]     = useState(null); // { url, siteName, title, clippedAt }
  const [highlights, setHighlights] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [empty,      setEmpty]      = useState(false); // no source + no body yet
  const [reloadTick, setReloadTick] = useState(0);

  const pathRef        = useRef(path);
  pathRef.current      = path;
  const highlightsRef  = useRef(highlights);
  highlightsRef.current = highlights;
  const currentHlRef   = useRef(null);
  const loadedPathRef  = useRef(null);
  const bodyRef        = useRef(null);

  // Load body (HTML) + sidecar, populate the container imperatively (React never
  // owns the container's children, so injected <mark>s survive re-renders).
  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    setSource(null);
    setHighlights([]);
    highlightsRef.current = [];
    loadedPathRef.current = null;
    let mounted = true;

    readFile(path).then(({ content, metadata }) => {
      if (!mounted) return;
      const hls = metadata?.highlights ?? [];
      const isEmpty = !metadata?.source && !(content && content.trim());
      setSource(metadata?.source ?? null);
      setHighlights(hls);
      setEmpty(isEmpty);
      highlightsRef.current = hls;
      loadedPathRef.current = path;
      // Defer DOM population until after the container is in the tree (skip when
      // showing the empty-state URL form — there's no body container then).
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
      setError(err.message ?? 'Failed to load clip');
      setLoading(false);
    });

    return () => { mounted = false; };
  }, [path, reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save: sidecar only (clip body is immutable)
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

  // highlightRef command contract (text-selection driven, like markdown/text)
  useEffect(() => {
    if (!highlightRef) return;

    const commands = {
      toggle: (color) => {
        const root = bodyRef.current;
        if (!root) return null;

        const existingId = highlightIdAtSelection(root);
        if (existingId) {
          const existing = highlightsRef.current.find((h) => h.id === existingId);
          if (existing?.color === color) {
            unwrap(root, existingId);
            const next = highlightsRef.current.filter((h) => h.id !== existingId);
            highlightsRef.current = next; setHighlights(next);
            return { kind: 'removed', id: existingId };
          }
          root.querySelectorAll(`mark[data-hl="${existingId}"]`).forEach((m) => m.setAttribute('data-color', color));
          const next = highlightsRef.current.map((h) =>
            h.id === existingId ? { ...h, color, updatedAt: new Date().toISOString() } : h);
          highlightsRef.current = next; setHighlights(next);
          return { kind: 'recolored', id: existingId };
        }

        const off = selectionOffsets(root);
        if (!off) return null;
        const now = new Date().toISOString();
        const id = generateId();
        const hl = {
          id, color, type: 'clip_range',
          start: off.start, end: off.end,
          text: off.text.trim().slice(0, 240),
          createdAt: now, updatedAt: now, cardHashes: [], refIds: [],
        };
        wrapOffsets(root, off.start, off.end, id, color);
        const next = [...highlightsRef.current, hl];
        highlightsRef.current = next; setHighlights(next);
        window.getSelection()?.removeAllRanges();
        return { kind: 'created', id };
      },

      unset: () => {
        const id = currentHlRef.current;
        if (!id) return null;
        const root = bodyRef.current;
        if (root) unwrap(root, id);
        const next = highlightsRef.current.filter((h) => h.id !== id);
        highlightsRef.current = next; setHighlights(next);
        currentHlRef.current = null;
        return { kind: 'removed', id };
      },

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
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return true; }
        return false;
      },
    };

    highlightRef.current = commands;
    return () => { if (highlightRef) highlightRef.current = null; };
  });

  if (loading) return <div className="renderer-loading">Loading clip…</div>;
  if (error)   return <div className="renderer-error">Could not load clip: {error}</div>;
  if (empty) {
    return (
      <SourceUrlForm
        title="Clip a web page"
        hint="Paste a URL to fetch a readable snapshot of the page. Images are saved locally so it stays available offline."
        placeholder="https://…"
        submitLabel="Clip page"
        busyLabel="Clipping…"
        onSubmit={async (url) => {
          await setClipSource(path, url);
          setReloadTick((t) => t + 1);
        }}
      />
    );
  }

  return (
    <div className="clip-renderer">
      {source && (
        <div className="clip-meta">
          {source.title && <div className="clip-meta-title">{source.title}</div>}
          <div className="clip-meta-sub">
            {source.url && (
              <a className="clip-meta-source" href={source.url} target="_blank" rel="noreferrer">
                {source.siteName || new URL(source.url).hostname} ↗
              </a>
            )}
            {source.clippedAt && (
              <span className="clip-meta-date">
                Clipped {new Date(source.clippedAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      )}
      <div ref={bodyRef} className="clip-body" />
    </div>
  );
}

ClipRenderer.supportsHighlight = true;
