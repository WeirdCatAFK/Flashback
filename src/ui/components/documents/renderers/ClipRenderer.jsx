import { useState, useEffect, useRef, useCallback } from 'react';
import { readFile, updateMetadata, setClipSource } from '../../../api/documents';
import { getBaseUrl, appendToken } from '../../../api/client';
import SourceUrlForm from './SourceUrlForm';
import { toLayoutRect, layoutViewport, useUiZoomChange } from '../../../utils/uiZoom';
import { useT } from '../../../translations';
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

// Point saved local assets (`./media/<name>`) at the API media endpoint, and record
// every asset's stored src in `data-href` on the way past. Covers pictures and sound
// alike — an <audio> and its <source> children carry the same kind of reference an
// <img> does, and an asset saved into the vault is exactly the one that should keep
// working with the network off.
//
// `data-href` is the identifier everything else here speaks in: it is what the clip
// file actually holds, which is both what saveClipAsset accepts and what
// listDocumentMedia reports. The live `src` cannot serve — it has either been
// rewritten to a tokenised API URL or, for an asset still on the web, been resolved
// by the browser into something that need not match the attribute.
function rewriteMedia(root, docPath) {
  root.querySelectorAll('img[src], audio[src], source[src]').forEach((el) => {
    const src = el.getAttribute('src') || '';
    el.setAttribute('data-href', src);
    const m = src.match(/^\.?\/?media\/(.+)$/);
    if (m) {
      el.setAttribute(
        'src',
        appendToken(`${getBaseUrl()}/api/media/file?docPath=${encodeURIComponent(docPath)}&name=${encodeURIComponent(m[1])}`),
      );
    }
  });
  // Sound published as a link. Most of the web does it this way — every Wikipedia
  // player is an <a> to the file — so a page can be full of sound and hold no <audio>
  // at all. Marking those links here is what puts them within reach of the same
  // gesture as everything else; saving one turns it into a real player.
  root.querySelectorAll('a[href]').forEach((el) => {
    const href = el.getAttribute('href') || '';
    if (isSoundLink(href)) el.setAttribute('data-href', href);
  });
}

// Mirrors the same predicate in mcpReader.js (which lists these) and documents.js
// (which saves them); the renderer is a different process, so it keeps its own.
// MIDI is out because no browser plays it — and because a `.mid` URL on Wikipedia is
// the file's description page, which is also why a last segment with a colon in it
// (`File:Something.ogg`) is out.
const PLAYABLE_SOUND_EXT = /\.(mp3|ogg|oga|wav|m4a|aac|flac|opus|weba)(\?|#|$)/i;
function isSoundLink(href) {
  if (!href) return false;
  const segment = href.split('?')[0].split('#')[0].split('/').pop() || '';
  if (segment.includes(':')) return false;
  return PLAYABLE_SOUND_EXT.test(segment);
}

// Where the save button goes for the asset under the pointer. A picture is big enough
// to wear it on its corner, the way a save button sits on an image everywhere else. A
// sound published as a link is a few characters wide — sitting on that would bury the
// thing it points at — so it goes beside it, and flips back to the corner near the
// right edge of the window rather than running off it.
const BESIDE_MAX_WIDTH = 160;
const ACTION_CLEARANCE = 240;
// `rect` is in shell-layout space (mediaHitFor converts it), so these constants and
// the window width they are compared against have to be too — see utils/uiZoom.js.
function actionPosition(rect) {
  const vw = layoutViewport().width;
  const beside = rect.width < BESIDE_MAX_WIDTH && rect.right + ACTION_CLEARANCE < vw;
  return beside
    ? { top: Math.max(8, rect.top - 2), left: rect.right + 8 }
    : { top: Math.max(8, rect.top + 8), right: Math.max(8, vw - rect.right + 8) };
}

// The asset under the pointer, as the card form needs to hear about it, or null when
// this element has nothing attachable. An inline `data:` picture is deliberately
// nothing: it is written into the clip body itself and cannot be lost, and there is
// no URL to save it from.
function mediaHitFor(el) {
  const isAudio = el.tagName === 'AUDIO';
  // A marked link is a sound too — a player the page rendered as an anchor.
  const isSound = isAudio || (el.tagName === 'A' && !!el.getAttribute('data-href'));
  const holder = isAudio ? (el.getAttribute('data-href') ? el : el.querySelector('source[data-href]')) : el;
  const href = holder?.getAttribute('data-href') || '';
  if (!href || /^data:/i.test(href)) return null;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    href,
    kind: isSound ? 'audio' : 'image',
    name: href.split('?')[0].split('#')[0].split('/').pop() || null,
    alt: el.getAttribute('alt')?.trim() || null,
    // Converted here, once, so every size threshold and placement offset downstream
    // is plain layout px and none of them has to know about app zoom.
    rect: toLayoutRect(rect),
  };
}

// ── Renderer ─────────────────────────────────────────────────────────────────

export default function ClipRenderer({
  path,
  saveRef,
  highlightRef,
  onHighlightsChange,
  onSidecarRefresh,
  onImagePick,
}) {
  const { t } = useT();
  const [source,     setSource]     = useState(null); // { url, siteName, title, clippedAt }
  const [highlights, setHighlights] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [empty,      setEmpty]      = useState(false); // no source + no body yet
  const [reloadTick, setReloadTick] = useState(0);
  // The picture or sound under the pointer: { href, kind, name, alt, rect } | null.
  const [mediaHit,   setMediaHit]   = useState(null);

  const pathRef        = useRef(path);
  pathRef.current      = path;
  const highlightsRef  = useRef(highlights);
  highlightsRef.current = highlights;
  const currentHlRef   = useRef(null);
  const loadedPathRef  = useRef(null);
  const bodyRef        = useRef(null);
  const onImagePickRef = useRef(onImagePick);
  onImagePickRef.current = onImagePick;

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
      setError(err.message ?? t('Failed to load clip'));
      setLoading(false);
    });

    return () => { mounted = false; };
  }, [path, reloadTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pinterest-style asset picking ──────────────────────────────────────────
  // Hovering a picture or a sound offers to put it on a card. This is the only
  // gesture that downloads anything: a clip's assets stay on their own host until
  // one is actually wanted, so this button is where a clip starts filling its own
  // media/ folder. The EPUB reader has the same affordance on a click; a clip is
  // ordinary DOM, so it can afford hover.
  const hideTimerRef = useRef(null);
  const cancelHide = useCallback(() => {
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);
  const hideSoon = useCallback(() => {
    cancelHide();
    // Not immediate: the button sits outside the body container, so travelling to
    // it means leaving the image, and an instant hide would make it unclickable.
    hideTimerRef.current = setTimeout(() => setMediaHit(null), 140);
  }, [cancelHide]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;

    const onOver = (e) => {
      // Anchors are in the list for the sound ones only; mediaHitFor returns null for
      // an ordinary link, since rewriteMedia marked no data-href on it.
      const el = e.target?.closest?.('img, audio, a[data-href]');
      if (!el || !root.contains(el)) return;
      const hit = mediaHitFor(el);
      // Too small to be worth a card, and the button would be larger than the
      // thing it points at — a status icon or a spacer. The card form's clip
      // picker still lists them.
      if (hit && (hit.rect.width < 48 || hit.rect.height < 48) && hit.kind !== 'audio') return;
      if (hit) { cancelHide(); setMediaHit(hit); }
    };
    const onOut = (e) => {
      if (e.target?.closest?.('img, audio, a[data-href]')) hideSoon();
    };
    const onScroll = () => { cancelHide(); setMediaHit(null); };

    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    // Capture: the scrolling element is an ancestor of this container, and its
    // scroll events never bubble to window on their own.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      cancelHide();
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [loading, error, empty, path, cancelHide, hideSoon]);

  // Same reasoning as the scroll dismissal above: an app-zoom change relays out the
  // body under the pointer, so the captured rect no longer points at the asset.
  useUiZoomChange(() => { cancelHide(); setMediaHit(null); });

  // Save: sidecar only — the body changes only when an asset is saved into the
  // vault, and saveClipAsset owns that write.
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
          // Same color is a no-op — removal only happens via the explicit
          // unset command, which confirms when cards are linked.
          if (existing?.color === color) {
            return { kind: 'existing', id: existingId };
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

      // Remove by registry id (Highlights tab delete button).
      remove: (id) => {
        if (!id || !highlightsRef.current.some((h) => h.id === id)) return null;
        const root = bodyRef.current;
        if (root) unwrap(root, id);
        const next = highlightsRef.current.filter((h) => h.id !== id);
        highlightsRef.current = next; setHighlights(next);
        if (currentHlRef.current === id) currentHlRef.current = null;
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

  if (loading) return <div className="renderer-loading">{t('Loading clip…')}</div>;
  if (error)   return <div className="renderer-error">{t('Could not load clip: {error}', { error })}</div>;
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
      {mediaHit && (
        // Overlaid on the asset's top-right corner, the way a save button sits on a
        // picture everywhere else. Fixed-position from a viewport rect, which is why
        // scrolling dismisses it rather than dragging it out of place.
        <button
          type="button"
          className="clip-media-action"
          style={actionPosition(mediaHit.rect)}
          onMouseEnter={cancelHide}
          onMouseLeave={hideSoon}
          onClick={() => {
            onImagePickRef.current?.({
              href: mediaHit.href, name: mediaHit.name, alt: mediaHit.alt, kind: mediaHit.kind,
            });
            cancelHide();
            setMediaHit(null);
          }}
        >
          {mediaHit.kind === 'audio' ? t('Make a card from this sound') : t('Make a card from this image')}
        </button>
      )}
    </div>
  );
}

ClipRenderer.supportsHighlight = true;
