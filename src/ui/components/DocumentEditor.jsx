import { useState, useCallback, useRef, useEffect } from 'react';
import EditorTabBar      from './EditorTabBar';
import EditorTitleBar    from './EditorTitleBar';
import SelectionToolbar  from './SelectionToolbar';
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
  const rendererRef = useRef(null);

  // Reset selection and inspector panel when the active file changes
  useEffect(() => {
    setSelection(null);
    setSelectionRect(null);
    setInspectorTab('cards');
  }, [activeTab]);

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
        onTabChange={onTabChange}
        onTabClose={onTabClose}
        onTabDoubleClick={onTabDoubleClick}
      />

      <div className="doc-editor-body">
        <div className="doc-editor-content">
          <EditorTitleBar path={activeTab} />

          <div
            className="doc-editor-renderer"
            ref={rendererRef}
            onMouseUp={handleMouseUp}
          >
            {Renderer && <Renderer path={activeTab} />}
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
        />
      </div>
    </div>
  );
}
