import { useState, useCallback, useRef, useEffect } from 'react';
import EditorTabBar    from './EditorTabBar';
import SelectionToolbar from './SelectionToolbar';
import Inspector         from './Inspector';
import MarkdownRenderer  from './renderers/MarkdownRenderer';
import TextRenderer      from './renderers/TextRenderer';
import PlaceholderRenderer from './renderers/PlaceholderRenderer';
import './DocumentEditor.css';

function pickRenderer(path) {
  if (!path) return null;
  const ext = path.replace(/\\/g, '/').split('/').pop().split('.').pop().toLowerCase();
  if (['md', 'markdown'].includes(ext)) return MarkdownRenderer;
  if (['txt', 'text'].includes(ext))    return TextRenderer;
  return PlaceholderRenderer;
}

export default function DocumentEditor({ openTabs, activeTab, previewTab, onTabChange, onTabClose, onTabDoubleClick }) {
  const [selection, setSelection]         = useState(null);
  const [selectionRect, setSelectionRect] = useState(null);
  const [inspectorTab, setInspectorTab]   = useState('cards');
  const [dirtyPaths, setDirtyPaths]       = useState(() => new Set());
  const [drafts, setDrafts]               = useState(() => new Map());
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const rendererRef = useRef(null);
  const saveRef     = useRef(null);

  // Reset selection and inspector panel when the active file changes
  useEffect(() => {
    setSelection(null);
    setSelectionRect(null);
    setInspectorTab('cards');
  }, [activeTab]);

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

  const clearSelection = useCallback(() => {
    setSelection(null);
    setSelectionRect(null);
  }, []);

  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const range = sel.getRangeAt(0);
    const rect  = range.getBoundingClientRect();
    setSelection({ text: sel.toString().trim(), startOffset: range.startOffset, endOffset: range.endOffset });
    setSelectionRect(rect);
  }, []);

  const handleMakeCard = useCallback(() => {
    setInspectorTab('new-card');
  }, []);

  const handleInspectorTabChange = useCallback((tab) => {
    setInspectorTab(tab);
    if (tab !== 'new-card') clearSelection();
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
                draftContent={drafts.get(activeTab)}
                onDraftChange={handleDraftChange}
              />
            )}
          </div>

          {selection && selectionRect && (
            <SelectionToolbar
              rect={selectionRect}
              onMakeCard={handleMakeCard}
              onClear={clearSelection}
            />
          )}
        </div>

        <Inspector
          path={activeTab}
          activeTab={inspectorTab}
          onTabChange={handleInspectorTabChange}
          selection={selection}
          onSelectionClear={clearSelection}
          open={inspectorOpen}
          onToggle={() => setInspectorOpen(o => !o)}
        />
      </div>
    </div>
  );
}
