import { useState, useCallback, useEffect, useRef } from 'react';
import FileExplorer  from '../components/FileExplorer';
import DocumentEditor from '../components/DocumentEditor';
import './Documents.css';

const MIN_WIDTH     = 150;
const MAX_WIDTH     = 500;
const DEFAULT_WIDTH = 240;

export default function DocumentsView({ openPaths, toggleOpen, relocatePaths, selectedPath, onSelect }) {
  const [sidebarWidth, setSidebarWidth] = useState(
    () => parseInt(localStorage.getItem('fb-sidebar-width') ?? DEFAULT_WIDTH, 10)
  );
  const dragging = useRef(false);
  const startX   = useRef(0);
  const startW   = useRef(0);

  const onMouseDown = useCallback((e) => {
    dragging.current = true;
    startX.current   = e.clientX;
    startW.current   = sidebarWidth;
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!dragging.current) return;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW.current + (e.clientX - startX.current)));
      setSidebarWidth(next);
    };
    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      setSidebarWidth(w => { localStorage.setItem('fb-sidebar-width', w); return w; });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
    };
  }, []);

  // ── Tab management ────────────────────────────────────────────────────────

  const [openTabs,  setOpenTabs]  = useState([]);
  const [previewTab, setPreviewTab] = useState(null);

  // Keep a ref so callbacks can read current openTabs without stale closures
  const openTabsRef = useRef([]);
  useEffect(() => { openTabsRef.current = openTabs; }, [openTabs]);

  // Single click: open as preview tab (replaces existing preview)
  const handleFileSelect = useCallback((path) => {
    const alreadyOpen = openTabsRef.current.some(t => t.path === path);
    if (!alreadyOpen) {
      setOpenTabs(prev => {
        const base = previewTab && previewTab !== path
          ? prev.filter(t => t.path !== previewTab)
          : prev;
        return [...base, { path }];
      });
      setPreviewTab(path);
    }
    onSelect(path);
  }, [previewTab, onSelect]);

  // Double click on file in explorer: open as permanent tab
  const handleFileDoubleSelect = useCallback((path) => {
    const alreadyOpen = openTabsRef.current.some(t => t.path === path);
    if (!alreadyOpen) {
      setOpenTabs(prev => {
        const base = previewTab && previewTab !== path
          ? prev.filter(t => t.path !== previewTab)
          : prev;
        return [...base, { path }];
      });
    }
    setPreviewTab(prev => prev === path ? null : prev);
    onSelect(path);
  }, [previewTab, onSelect]);

  // Double click on a tab: make it permanent
  const handleTabDoubleClick = useCallback((path) => {
    setPreviewTab(prev => prev === path ? null : prev);
  }, []);

  const handleTabChange = useCallback((path) => {
    onSelect(path);
  }, [onSelect]);

  const handleTabClose = useCallback((path) => {
    setOpenTabs(prev => {
      const next = prev.filter(t => t.path !== path);
      if (selectedPath === path) {
        onSelect(next.length > 0 ? next[next.length - 1].path : null);
      }
      return next;
    });
    setPreviewTab(prev => prev === path ? null : prev);
  }, [selectedPath, onSelect]);

  return (
    <div className="documents-view">
      <aside className="documents-sidebar" style={{ width: sidebarWidth }}>
        <FileExplorer
          workspaceName="Workspace"
          onSelect={handleFileSelect}
          onDoubleSelect={handleFileDoubleSelect}
          selectedPath={selectedPath}
          openPaths={openPaths}
          toggleOpen={toggleOpen}
          relocatePaths={relocatePaths}
        />
      </aside>

      <div className="documents-resize-handle" onMouseDown={onMouseDown} />

      <main className="documents-main">
        <DocumentEditor
          openTabs={openTabs}
          activeTab={selectedPath}
          previewTab={previewTab}
          onTabChange={handleTabChange}
          onTabClose={handleTabClose}
          onTabDoubleClick={handleTabDoubleClick}
        />
      </main>
    </div>
  );
}
