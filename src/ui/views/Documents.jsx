import { useState, useCallback, useEffect, useRef } from 'react';
import FileExplorer from '../components/FileExplorer';
import './Documents.css';

const MIN_WIDTH = 150;
const MAX_WIDTH = 500;
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
    document.body.style.cursor    = 'col-resize';
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

  return (
    <div className="documents-view">
      <aside className="documents-sidebar" style={{ width: sidebarWidth }}>
        <FileExplorer workspaceName="Workspace" onSelect={onSelect} selectedPath={selectedPath}
          openPaths={openPaths} toggleOpen={toggleOpen} relocatePaths={relocatePaths} />
      </aside>

      <div className="documents-resize-handle" onMouseDown={onMouseDown} />

      <main className="documents-main">
        {selectedPath
          ? <p className="documents-placeholder">Selected: {selectedPath}</p>
          : <p className="documents-placeholder">Select a file to open it.</p>
        }
      </main>
    </div>
  );
}
