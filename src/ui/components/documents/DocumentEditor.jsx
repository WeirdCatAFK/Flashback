import { useState, useCallback, useRef, useEffect } from 'react';
import EditorTabBar    from './EditorTabBar';
import SelectionToolbar from './SelectionToolbar';
import Inspector         from './inspector/Inspector';
import HighlightRemoveDialog from './HighlightRemoveDialog';
import MarkdownRenderer  from './renderers/MarkdownRenderer';
import TextRenderer      from './renderers/TextRenderer';
import PdfRenderer       from './renderers/PdfRenderer';
import PlaceholderRenderer from './renderers/PlaceholderRenderer';
import { readFile } from '../../api/documents';
import './DocumentEditor.css';

function pickRenderer(path) {
  if (!path) return null;
  const ext = path.replace(/\\/g, '/').split('/').pop().split('.').pop().toLowerCase();
  if (['md', 'markdown'].includes(ext)) return MarkdownRenderer;
  if (['txt', 'text'].includes(ext))    return TextRenderer;
  if (ext === 'pdf')                    return PdfRenderer;
  return PlaceholderRenderer;
}

const DEFAULT_HL_COLOR = 'amber';

export default function DocumentEditor({ isActive = true, openTabs, activeTab, previewTab, onTabChange, onTabClose, onTabDoubleClick, pendingHighlight, onHighlightConsumed }) {
  const [selection, setSelection]         = useState(null);
  const [selectionRect, setSelectionRect] = useState(null);
  const [inspectorTab, setInspectorTab]   = useState('cards');
  const [dirtyPaths, setDirtyPaths]       = useState(() => new Set());
  const [drafts, setDrafts]               = useState(() => new Map());
  const [inspectorOpen, setInspectorOpen] = useState(true);
  // Sidecar-derived state for the active file
  const [highlights, setHighlights]       = useState([]);
  const [flashcards, setFlashcards]       = useState([]);
  const [selectedHighlightId, setSelectedHighlightId] = useState(null);
  // Orphan-removal confirmation: { id, cardCount } | null
  const [pendingRemoval, setPendingRemoval] = useState(null);

  const rendererRef  = useRef(null);
  const saveRef      = useRef(null);
  const highlightRef = useRef(null);

  // A renderer opts into the highlight system by exposing a static
  // `supportsHighlight` flag (see useHighlightableRenderer). DocumentEditor
  // stays agnostic about which renderers those are.
  const activeRenderer = pickRenderer(activeTab);
  const supportsHighlight = !!activeRenderer?.supportsHighlight;

  // Reset selection and inspector panel inline when the active file changes.
  // Inline (not useEffect) so users never see a stale-state intermediate render.
  const [prevActiveTab, setPrevActiveTab] = useState(activeTab);
  if (prevActiveTab !== activeTab) {
    setPrevActiveTab(activeTab);
    setSelection(null);
    setSelectionRect(null);
    setInspectorTab('cards');
    setSelectedHighlightId(null);
    setPendingRemoval(null);
    setHighlights([]);
    setFlashcards([]);
  }

  // The toolbar is portalled to document.body and floats above everything.
  // Views stay mounted when switching (App.jsx), so clear inline when ours hides.
  const [prevIsActive, setPrevIsActive] = useState(isActive);
  if (prevIsActive !== isActive) {
    setPrevIsActive(isActive);
    if (!isActive) {
      setSelection(null);
      setSelectionRect(null);
    }
  }

  // Drop dirty state and drafts for tabs that have been closed
  useEffect(() => {
    const openSet = new Set(openTabs.map(t => t.path));
    setDirtyPaths(prev => {
      const next = new Set([...prev].filter(p => openSet.has(p)));
      return next.size !== prev.size ? next : prev;
    });
    setDrafts(prev => {
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!openSet.has(key)) { next.delete(key); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [openTabs]);

  const handleDirtyChange = useCallback((path, isDirty) => {
    setDirtyPaths(prev => {
      const next = new Set(prev);
      if (isDirty) next.add(path); else next.delete(path);
      return next;
    });
  }, []);

  const handleDraftChange = useCallback((path, content) => {
    setDrafts(prev => {
      const next = new Map(prev);
      if (content === undefined) next.delete(path); else next.set(path, content);
      return next;
    });
  }, []);

  // The renderer reports the current highlight registry / full sidecar after
  // load and after every save.
  const handleHighlightsChange = useCallback((path, hls) => {
    if (path === activeTab) setHighlights(hls ?? []);
  }, [activeTab]);

  const handleSidecarRefresh = useCallback((path, meta) => {
    if (path === activeTab) setFlashcards(meta?.flashcards ?? []);
  }, [activeTab]);

  // Re-read the sidecar from disk — used after the Inspector writes a card,
  // which bypasses the renderer's save path.
  const refreshSidecar = useCallback(async (path) => {
    try {
      const data = await readFile(path);
      const meta = data.metadata ?? {};
      if (path === activeTab) {
        setHighlights(meta.highlights ?? []);
        setFlashcards(meta.flashcards ?? []);
      }
    } catch { /* ignore */ }
  }, [activeTab]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setSelectionRect(null);
  }, []);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      clearSelection();
      return;
    }
    const range = sel.getRangeAt(0);
    const rect  = range.getBoundingClientRect();
    setSelection({ text: sel.toString().trim(), startOffset: range.startOffset, endOffset: range.endOffset });
    setSelectionRect(rect);
  }, [clearSelection]);

  // The toolbar is a fixed-position overlay anchored to the selection rect.
  // It must hide whenever that rect would be wrong: selection emptied
  // (clicked elsewhere, typed, etc.) or anything scrolled the rect off.
  useEffect(() => {
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        clearSelection();
      }
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [clearSelection]);

  useEffect(() => {
    if (!selectionRect) return;
    const el = rendererRef.current;
    const onScroll = () => clearSelection();
    el?.addEventListener('scroll', onScroll, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      el?.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [selectionRect, clearSelection]);

  const countCardsForHighlight = useCallback((id) =>
    flashcards.filter(c => c?.vanillaData?.location?.type === 'highlight'
      && c?.vanillaData?.location?.id === id).length
  , [flashcards]);

  // Apply a highlight color and persist (each highlight = one save/commit,
  // matching the app's one-commit-per-action model).
  const handleHighlight = useCallback((color) => {
    highlightRef.current?.toggle?.(color);
    clearSelection();
    saveRef.current?.();
  }, [clearSelection]);

  // X button: if the highlight under the selection has linked cards, confirm
  // before severing the anchor.
  const handleUnhighlightRequest = useCallback(() => {
    const id = highlightRef.current?.currentId?.();
    if (!id) { highlightRef.current?.unset?.(); clearSelection(); saveRef.current?.(); return; }
    const count = countCardsForHighlight(id);
    if (count > 0) {
      setPendingRemoval({ id, cardCount: count });
      return;
    }
    highlightRef.current?.unset?.();
    clearSelection();
    saveRef.current?.();
  }, [clearSelection, countCardsForHighlight]);

  const resolveRemoval = useCallback((deleteCards) => {
    const id = pendingRemoval?.id;
    setPendingRemoval(null);
    highlightRef.current?.unset?.();
    clearSelection();
    const transform = deleteCards && id
      ? (meta) => ({
          ...meta,
          flashcards: (meta.flashcards ?? []).filter(
            c => !(c?.vanillaData?.location?.type === 'highlight' && c?.vanillaData?.location?.id === id)
          ),
        })
      : undefined;
    saveRef.current?.(transform);
  }, [pendingRemoval, clearSelection]);

  // Card button: anchor the selection to a highlight, then open the New Card
  // form with that highlight id so the card stores a stable reference.
  const handleMakeCard = useCallback(() => {
    const res = highlightRef.current?.ensure?.(DEFAULT_HL_COLOR);
    if (res?.id) {
      setSelectedHighlightId(res.id);
      if (res.kind === 'created') saveRef.current?.();
    } else {
      setSelectedHighlightId(null);
    }
    setInspectorTab('new-card');
  }, []);

  // Ref button: just create the highlight (no card). The highlight itself is
  // the reference; it shows up in the Highlights tab.
  const handleMakeRef = useCallback(() => {
    const res = highlightRef.current?.ensure?.(DEFAULT_HL_COLOR);
    clearSelection();
    if (res?.kind === 'created') saveRef.current?.();
  }, [clearSelection]);

  const handleCardSaved = useCallback(() => {
    clearSelection();
    setSelectedHighlightId(null);
    setInspectorTab('cards');
    if (activeTab) refreshSidecar(activeTab);
  }, [clearSelection, activeTab, refreshSidecar]);

  const handleJumpToHighlight = useCallback((id) => {
    highlightRef.current?.scrollTo?.(id);
  }, []);

  // Stable ref: onHighlightConsumed is an inline arrow in DocumentsView so its
  // reference changes every render; using a ref avoids adding it to the deps
  // (which would wrongly re-run the timeout on every parent render).
  const onHighlightConsumedRef = useRef(onHighlightConsumed);
  onHighlightConsumedRef.current = onHighlightConsumed;

  // Scroll to a highlight requested from an external navigation (e.g. trainer
  // "view source"). Waits until the target highlight appears in the loaded
  // highlights array — meaning the document's content and marks are in the DOM.
  useEffect(() => {
    if (!pendingHighlight || pendingHighlight.path !== activeTab) return;
    const targetId = pendingHighlight.id;
    if (!highlights.some(h => h.id === targetId)) return;
    const t = setTimeout(() => {
      highlightRef.current?.scrollTo?.(targetId);
      onHighlightConsumedRef.current?.();
    }, 80);
    return () => clearTimeout(t);
  }, [highlights, pendingHighlight, activeTab]);

  const handleHighlightCardRequest = useCallback((highlightId) => {
    setSelectedHighlightId(highlightId);
    setInspectorTab('new-card');
  }, []);

  const handleInspectorTabChange = useCallback((tab) => {
    setInspectorTab(tab);
    if (tab !== 'new-card') {
      clearSelection();
      setSelectedHighlightId(null);
    }
  }, [clearSelection]);

  const Renderer = pickRenderer(activeTab);

  if (!activeTab || openTabs.length === 0) {
    return (
      <div className="doc-editor doc-editor--empty">
        <p>Select a file to open it.</p>
      </div>
    );
  }

  return (
    <div className="doc-editor">
      <EditorTabBar
        tabs={openTabs}
        activeTab={activeTab}
        previewTab={previewTab}
        dirtyPaths={dirtyPaths}
        onTabChange={onTabChange}
        onTabClose={onTabClose}
        onTabDoubleClick={onTabDoubleClick}
      />

      <div className="doc-editor-body">
        <div className="doc-editor-content">
          <div
            className="doc-editor-renderer"
            ref={rendererRef}
            onMouseUp={handleMouseUp}
          >
            {Renderer && (
              <Renderer
                path={activeTab}
                onDirtyChange={handleDirtyChange}
                saveRef={saveRef}
                highlightRef={highlightRef}
                onHighlightsChange={handleHighlightsChange}
                onSidecarRefresh={handleSidecarRefresh}
                draftContent={drafts.get(activeTab)}
                onDraftChange={handleDraftChange}
              />
            )}
          </div>

          {isActive && selection && selectionRect && (
            <SelectionToolbar
              rect={selectionRect}
              onMakeCard={handleMakeCard}
              onMakeRef={handleMakeRef}
              onHighlight={supportsHighlight ? handleHighlight : undefined}
              onUnhighlight={supportsHighlight ? handleUnhighlightRequest : undefined}
              onClear={clearSelection}
            />
          )}
        </div>

        <Inspector
          path={activeTab}
          activeTab={inspectorTab}
          onTabChange={handleInspectorTabChange}
          selection={selection}
          selectedHighlightId={selectedHighlightId}
          highlights={highlights}
          flashcards={flashcards}
          onJumpToHighlight={handleJumpToHighlight}
          onHighlightCardRequest={handleHighlightCardRequest}
          onCardSaved={handleCardSaved}
          onSelectionClear={clearSelection}
          open={inspectorOpen}
          onToggle={() => setInspectorOpen(o => !o)}
        />
      </div>

      {pendingRemoval && (
        <HighlightRemoveDialog
          cardCount={pendingRemoval.cardCount}
          onCancel={() => setPendingRemoval(null)}
          onKeepCards={() => resolveRemoval(false)}
          onDeleteCards={() => resolveRemoval(true)}
        />
      )}
    </div>
  );
}
