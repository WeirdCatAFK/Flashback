import { useState, useEffect, useRef, useCallback } from 'react';
import ePub from 'epubjs';
import { readFile, updateMetadata, fetchRaw } from '../../../api/documents';
import './EpubRenderer.css';
import './Renderer.css';

// Reflowable-EPUB renderer. Mirrors PdfRenderer's standalone pattern rather than
// useHighlightableRenderer: the EPUB body is immutable, so highlights live only
// in the sidecar and saving never touches the file. Anchoring uses EPUB CFI
// (Canonical Fragment Identifier) ranges — layout-independent, so highlights
// survive font-size changes and repagination without offset math.
//
// epub.js renders each spine section into a sandboxed iframe, so text selection
// happens inside that iframe (invisible to DocumentEditor's top-window selection
// pipeline). We bridge it: listen to epub.js's `selected` event, translate the
// iframe-relative rect to viewport coords, and drive DocumentEditor's existing
// SelectionToolbar via the onExternalSelection prop. The highlight commands then
// operate on the stored pending CFI range instead of window.getSelection().

const HL_VARS = { amber: '--color-hl-1', green: '--color-hl-2', blue: '--color-hl-3', pink: '--color-hl-4' };
const FONT_MIN = 80;
const FONT_MAX = 200;
const FONT_STEP = 10;
const FONT_DEFAULT = 100;

function generateId() {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return 'h_' + (rand[0].toString(36) + rand[1].toString(36)).slice(0, 9);
}

// Resolve a highlight colour key to a concrete colour string. epub.js paints the
// annotation SVG inside the iframe, where our app stylesheet can't reach, so the
// fill must be an explicit value rather than a CSS class.
function resolveColor(key) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(HL_VARS[key] ?? HL_VARS.amber).trim();
  return v || '#f5c542';
}

function isDarkTheme() {
  const attr = document.documentElement.dataset.theme;
  if (attr) return attr === 'dark';
  return !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

export default function EpubRenderer({
  path,
  saveRef,
  highlightRef,
  onHighlightsChange,
  onSidecarRefresh,
  onExternalSelection,
}) {
  const [highlights, setHighlights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [ready, setReady]     = useState(false);
  const [fontPct, setFontPct] = useState(FONT_DEFAULT);
  const [progress, setProgress] = useState(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd]     = useState(false);

  const viewportRef   = useRef(null);
  const bookRef       = useRef(null);
  const renditionRef  = useRef(null);
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const pathRef       = useRef(path);
  pathRef.current     = path;
  const loadedPathRef = useRef(null);
  const fontPctRef    = useRef(fontPct);
  fontPctRef.current  = fontPct;
  // { cfiRange, text } for the live in-iframe selection, or null.
  const pendingSelRef = useRef(null);
  // Last highlight the user interacted with (matched selection or clicked mark).
  const currentHlRef  = useRef(null);
  // cfi -> colour of annotations currently painted, for diffed reconciliation.
  const appliedRef    = useRef(new Map());
  const onExternalSelectionRef = useRef(onExternalSelection);
  onExternalSelectionRef.current = onExternalSelection;

  const findByCfi = (cfi) => highlightsRef.current.find(h => h.cfi === cfi);

  const addHighlight = useCallback((cfiRange, color, text) => {
    const id = generateId();
    const now = new Date().toISOString();
    const hl = {
      id, color, type: 'epub_cfi', cfi: cfiRange,
      text: (text ?? '').trim().slice(0, 240),
      createdAt: now, updatedAt: now, cardHashes: [], refIds: [],
    };
    const next = [...highlightsRef.current, hl];
    highlightsRef.current = next;
    setHighlights(next);
    currentHlRef.current = id;
    return id;
  }, []);

  const removeHighlight = useCallback((id) => {
    const next = highlightsRef.current.filter(h => h.id !== id);
    highlightsRef.current = next;
    setHighlights(next);
  }, []);

  // --- Load book + sidecar ---------------------------------------------------
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let book = null;
    let rendition = null;
    setLoading(true);
    setError(null);
    setReady(false);
    setProgress(null);
    appliedRef.current = new Map();
    pendingSelRef.current = null;
    currentHlRef.current = null;
    loadedPathRef.current = null;

    (async () => {
      try {
        const [buf, meta] = await Promise.all([
          fetchRaw(path),
          readFile(path).then(d => d.metadata ?? {}).catch(() => ({})),
        ]);
        if (cancelled || !viewportRef.current) return;

        book = ePub(buf);
        bookRef.current = book;
        rendition = book.renderTo(viewportRef.current, {
          width: '100%',
          height: '100%',
          flow: 'paginated',
          spread: 'none',
          allowScriptedContent: false,
        });
        renditionRef.current = rendition;

        // Theme: a minimal light/dark base so the page blends with the app shell.
        // We only set body colour/background — forcing author-styled elements is a
        // rabbit hole, so content keeps its own formatting.
        const dark = isDarkTheme();
        rendition.themes.register('fb', dark
          ? { body: { color: '#d6d3cd', background: '#1c1a17' }, a: { color: '#e0a44a' } }
          : { body: { color: '#1c1a17', background: '#faf8f4' }, a: { color: '#b06d12' } });
        rendition.themes.select('fb');
        rendition.themes.fontSize(`${fontPctRef.current}%`);

        wireRendition(rendition);

        const hls = meta.highlights ?? [];
        setHighlights(hls);
        highlightsRef.current = hls;

        await rendition.display();
        if (cancelled) return;

        loadedPathRef.current = path;
        onHighlightsChange?.(path, hls);
        onSidecarRefresh?.(path, meta);
        setReady(true);
        setLoading(false);

        // Background: page-count locations for an accurate progress %. Large books
        // take a moment; failure just leaves progress null.
        book.ready
          .then(() => book.locations.generate(1600))
          .catch(() => {});
      } catch (err) {
        if (!cancelled) {
          setError(err?.message ?? 'Failed to load EPUB');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      try { rendition?.destroy(); } catch { /* ignore */ }
      try { book?.destroy(); } catch { /* ignore */ }
      renditionRef.current = null;
      bookRef.current = null;
    };
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attach epub.js event listeners. Split out so the load effect stays readable.
  function wireRendition(rendition) {
    // Text selected inside the section iframe.
    rendition.on('selected', (cfiRange, contents) => {
      let text = '';
      let rect = null;
      try {
        const range = contents.range(cfiRange);
        text = range?.toString() ?? '';
        const r = range?.getBoundingClientRect();
        const iframe = contents.document?.defaultView?.frameElement;
        const io = iframe?.getBoundingClientRect();
        if (r && io) {
          // `r` comes from range.getBoundingClientRect() *inside* the section
          // iframe, which stays in the iframe's own layout pixels; `io` is the
          // iframe element measured in the top document, whose coordinates ARE
          // scaled by the page zoom. When zoom ≠ 100% (Chromium stores it per
          // origin, so a packaged file:// build can differ from dev) the two are
          // in different scales and composing them directly makes the toolbar
          // drift a little further each page. Scale the in-iframe rect by the
          // iframe's rendered/layout ratio (the effective zoom) first; this is
          // a no-op at 100%.
          const scaleX = iframe.offsetWidth ? io.width / iframe.offsetWidth : 1;
          const scaleY = iframe.offsetHeight ? io.height / iframe.offsetHeight : 1;
          rect = {
            top:    io.top  + r.top   * scaleY,
            left:   io.left + r.left  * scaleX,
            width:  r.width  * scaleX,
            height: r.height * scaleY,
          };
        }
      } catch { /* ignore */ }
      pendingSelRef.current = { cfiRange, text };
      if (rect) onExternalSelectionRef.current?.({ text: text.trim(), rect });
    });

    // Clicking an existing highlight marks it as current (for recolour/removal).
    rendition.on('markClicked', (cfiRange) => {
      const h = findByCfi(cfiRange);
      if (h) currentHlRef.current = h.id;
    });

    // Collapsed selection (click elsewhere / new drag start) → drop the pending
    // selection and hide the toolbar.
    rendition.hooks.content.register((contents) => {
      const doc = contents.document;
      doc.addEventListener('selectionchange', () => {
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed) {
          pendingSelRef.current = null;
          onExternalSelectionRef.current?.(null);
        }
      });
    });

    rendition.on('relocated', (loc) => {
      const pct = loc?.start?.percentage;
      setProgress(typeof pct === 'number' && pct > 0 ? Math.round(pct * 100) : null);
      setAtStart(!!loc?.atStart);
      setAtEnd(!!loc?.atEnd);
    });
  }

  // --- Keep painted annotations in sync with the registry --------------------
  useEffect(() => {
    const rend = renditionRef.current;
    if (!rend || !ready) return;
    const desired = new Map(highlights.map(h => [h.cfi, h.color]));

    for (const [cfi, color] of appliedRef.current) {
      if (desired.get(cfi) !== color) {
        try { rend.annotations.remove(cfi, 'highlight'); } catch { /* ignore */ }
        appliedRef.current.delete(cfi);
      }
    }
    for (const h of highlights) {
      if (appliedRef.current.get(h.cfi) === h.color) continue;
      try {
        rend.annotations.add(
          'highlight', h.cfi, { id: h.id },
          () => { currentHlRef.current = h.id; },
          '',
          { fill: resolveColor(h.color), 'fill-opacity': '0.3' },
        );
        appliedRef.current.set(h.cfi, h.color);
      } catch { /* ignore */ }
    }
  }, [highlights, ready]);

  // --- Resize handling (paginated columns must re-flow) ----------------------
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let t = null;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { try { renditionRef.current?.resize(); } catch { /* ignore */ } }, 150);
    });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, []);

  // --- Save (sidecar only; EPUB body never changes) --------------------------
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async (metaTransform) => {
    const savedPath = pathRef.current;
    if (loadedPathRef.current !== savedPath) return;
    try {
      let baseMeta = {};
      try { baseMeta = (await readFile(savedPath)).metadata ?? {}; } catch { /* ok */ }
      if (metaTransform) baseMeta = metaTransform(baseMeta);
      const nextMeta = { ...baseMeta, highlights: highlightsRef.current };
      await updateMetadata(savedPath, nextMeta);
      onHighlightsChange?.(savedPath, highlightsRef.current);
      onSidecarRefresh?.(savedPath, nextMeta);
    } catch { /* dirty state stays; user can retry */ }
  };

  useEffect(() => {
    if (saveRef) saveRef.current = (meta) => handleSaveRef.current?.(meta);
    return () => { if (saveRef) saveRef.current = null; };
  });

  // --- Highlight command surface (driven by DocumentEditor's toolbar) --------
  useEffect(() => {
    if (!highlightRef) return;
    const commands = {
      toggle: (color) => {
        const pend = pendingSelRef.current;
        if (!pend) return null;
        const existing = findByCfi(pend.cfiRange);
        if (existing) {
          // Same color is a no-op — removal only happens via the explicit
          // unset command, which confirms when cards are linked.
          if (existing.color === color) {
            currentHlRef.current = existing.id;
            return { kind: 'existing', id: existing.id };
          }
          const next = highlightsRef.current.map(h =>
            h.id === existing.id ? { ...h, color, updatedAt: new Date().toISOString() } : h);
          highlightsRef.current = next;
          setHighlights(next);
          currentHlRef.current = existing.id;
          return { kind: 'recolored', id: existing.id };
        }
        return { kind: 'created', id: addHighlight(pend.cfiRange, color, pend.text) };
      },
      ensure: (color = 'amber') => {
        const pend = pendingSelRef.current;
        if (!pend) return null;
        const existing = findByCfi(pend.cfiRange);
        if (existing) { currentHlRef.current = existing.id; return { kind: 'existing', id: existing.id }; }
        return { kind: 'created', id: addHighlight(pend.cfiRange, color, pend.text) };
      },
      unset: () => {
        const pend = pendingSelRef.current;
        const id = currentHlRef.current ?? (pend && findByCfi(pend.cfiRange)?.id) ?? null;
        if (!id) return null;
        removeHighlight(id);
        currentHlRef.current = null;
        return { kind: 'removed', id };
      },
      // Remove by registry id (Highlights tab delete button).
      remove: (id) => {
        if (!id || !highlightsRef.current.some(h => h.id === id)) return null;
        removeHighlight(id);
        if (currentHlRef.current === id) currentHlRef.current = null;
        return { kind: 'removed', id };
      },
      currentId: () => {
        const pend = pendingSelRef.current;
        const id = (pend && findByCfi(pend.cfiRange)?.id) ?? currentHlRef.current ?? null;
        currentHlRef.current = id;
        return id;
      },
      scrollTo: (id) => {
        const h = highlightsRef.current.find(x => x.id === id);
        if (h?.cfi) { renditionRef.current?.display(h.cfi); return true; }
        return false;
      },
    };
    highlightRef.current = commands;
    return () => { if (highlightRef) highlightRef.current = null; };
  });

  // --- Navigation ------------------------------------------------------------
  const goPrev = useCallback(() => renditionRef.current?.prev(), []);
  const goNext = useCallback(() => renditionRef.current?.next(), []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target?.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'ArrowLeft')  { goPrev(); }
      if (e.key === 'ArrowRight') { goNext(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPrev, goNext]);

  const changeFont = useCallback((delta) => {
    setFontPct(p => {
      const n = Math.min(FONT_MAX, Math.max(FONT_MIN, p + delta));
      try { renditionRef.current?.themes.fontSize(`${n}%`); } catch { /* ignore */ }
      return n;
    });
  }, []);

  return (
    <div className="epub-renderer">
      <div className="epub-toolbar">
        <button className="epub-btn" onClick={goPrev} disabled={atStart} title="Previous page">‹</button>
        <button className="epub-btn" onClick={goNext} disabled={atEnd} title="Next page">›</button>
        <span className="epub-progress">{progress != null ? `${progress}%` : ''}</span>
        <div className="epub-toolbar-spacer" />
        <button className="epub-btn epub-btn--font" onClick={() => changeFont(-FONT_STEP)} disabled={fontPct <= FONT_MIN} title="Smaller text">A−</button>
        <span className="epub-font-label">{fontPct}%</span>
        <button className="epub-btn epub-btn--font" onClick={() => changeFont(FONT_STEP)} disabled={fontPct >= FONT_MAX} title="Larger text">A+</button>
      </div>

      <div className="epub-viewport-wrap">
        <div ref={viewportRef} className="epub-viewport" />
        {loading && <div className="renderer-loading epub-overlay">Loading EPUB…</div>}
        {error && <div className="renderer-error epub-overlay">Could not load EPUB: {error}</div>}
      </div>
    </div>
  );
}

EpubRenderer.supportsHighlight = true;
