import { useState, useEffect, useCallback, useRef } from 'react';
import { listFolder, createFile, createFolder, deleteItem, moveItem, renameItem } from '../api/documents';
import IconFolder from './icons/IconFolder';
import IconFolderOpen from './icons/IconFolderOpen';
import IconFile from './icons/IconFile';
import getFileIcon from './icons/fileIconMap';
import ContextMenu from './ContextMenu';
import './FileExplorer.css';

const sortItems = (items) =>
  [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

// Strip characters Windows forbids in filenames: \ / : * ? " < > |
const sanitizeName = (s) => s.replace(/[\\/:*?"<>|]/g, '');

// ── Inline create input ───────────────────────────────────────────────────────

function InlineCreate({ type, onConfirm, onCancel }) {
  const defaultName = type === 'folder' ? 'New Folder' : 'new_file';
  const [name, setName] = useState(defaultName);

  const commit = () => {
    const trimmed = name.trim();
    if (!trimmed) { onCancel(); return; }
    onConfirm(type === 'file' ? trimmed.includes('.') ? trimmed : `${trimmed}.md` : trimmed);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter')  commit();
    if (e.key === 'Escape') onCancel();
    e.stopPropagation();
  };

  return (
    <div className={type === 'folder' ? 'fe-folder' : 'fe-file'} style={{ pointerEvents: 'none' }}>
      {type === 'folder' && <span className="fe-chevron" />}
      {type === 'folder'
        ? <span className="fe-folder-icon"><IconFolder size={14} /></span>
        : <IconFile size={14} />
      }
      <span className="fe-item-label" style={{ pointerEvents: 'auto' }}>
        <input
          className="fe-rename-input"
          value={name}
          autoFocus
          onChange={e => setName(sanitizeName(e.target.value))}
          onKeyDown={handleKey}
          onBlur={commit}
          onFocus={e => e.target.select()}
          onClick={e => e.stopPropagation()}
        />
      </span>
    </div>
  );
}

// ── File ──────────────────────────────────────────────────────────────────────

function FileNode({ name, path, onRefresh, onSelect, selectedPath, onCtxMenu }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);
  const FileIcon = getFileIcon(name);
  const selected = path === selectedPath;
  const nodeRef = useRef(null);

  useEffect(() => {
    if (selected) nodeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const handleDragStart = (e) => {
    e.dataTransfer.setData('fb-path', path);
    e.dataTransfer.setData('fb-is-folder', 'false');
    e.stopPropagation();
  };

  const commitRename = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) { setDraft(name); setRenaming(false); return; }
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    const base = trimmed.replace(/\.+$/, '');
    const newName = ext && (!trimmed.includes('.') || trimmed.endsWith('.')) ? base + ext : trimmed;
    try {
      await renameItem(path, newName, false);
      onRefresh();
    } catch {
      setDraft(name);
    }
    setRenaming(false);
  };

  const handleRenameKey = (e) => {
    if (e.key === 'Enter')  commitRename();
    if (e.key === 'Escape') { setDraft(name); setRenaming(false); }
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu(e, {
      isFolder: false,
      triggerRename: () => setRenaming(true),
      doDelete: async () => { await deleteItem(path, false); onRefresh(); },
    });
  };

  return (
    <div
      ref={nodeRef}
      className={`fe-file${selected ? ' fe-selected' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onClick={() => !renaming && onSelect?.(path)}
      onContextMenu={handleContextMenu}
    >
      <FileIcon size={14} />
      <span className="fe-item-label">
        {renaming
          ? <input className="fe-rename-input" value={draft} autoFocus
              onChange={e => setDraft(sanitizeName(e.target.value))}
              onKeyDown={handleRenameKey}
              onBlur={commitRename}
              onClick={e => e.stopPropagation()}
            />
          : name
        }
      </span>
    </div>
  );
}

// ── Folder ────────────────────────────────────────────────────────────────────

function FolderNode({ name, path, onRefresh, onSelect, selectedPath, openPaths, toggleOpen, relocatePaths, onCtxMenu }) {
  const open = openPaths.has(path);
  const selected = path === selectedPath;
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft]       = useState(name);
  const [dragOver, setDragOver] = useState(false);
  const [pendingNew, setPendingNew] = useState(null); // null | 'file' | 'folder'
  const nodeRef = useRef(null);

  useEffect(() => {
    if (selected) nodeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    try { setChildren(sortItems(await listFolder(path))); }
    catch (err) { console.error('Load failed', err); }
    finally { setLoading(false); }
  }, [path]);

  // If this node mounts while already marked open (e.g. after a tree refresh),
  // fetch its children immediately so the folder doesn't appear empty.
  useEffect(() => {
    if (open) loadChildren();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    if (!open) loadChildren();
    toggleOpen(path);
    onSelect?.(path);
  };

  const refresh = () => { if (open) loadChildren(); onRefresh(); };

  const handleDragStart = (e) => {
    e.dataTransfer.setData('fb-path', path);
    e.dataTransfer.setData('fb-is-folder', 'true');
    e.stopPropagation();
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const srcPath  = e.dataTransfer.getData('fb-path');
    const isFolder = e.dataTransfer.getData('fb-is-folder') === 'true';
    if (!srcPath || srcPath === path || path.startsWith(srcPath + '/')) return;
    const srcName = srcPath.replace(/\\/g, '/').split('/').pop();
    const destPath = `${path}/${srcName}`;
    if (srcPath.replace(/\\/g, '/') === destPath.replace(/\\/g, '/')) return;
    try {
      await moveItem(srcPath, destPath, isFolder);
      if (isFolder) relocatePaths(srcPath, destPath);
      refresh();
    } catch (err) { console.error('Move failed', err); }
  };

  const commitRename = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) { setDraft(name); setRenaming(false); return; }
    try {
      await renameItem(path, trimmed, true);
      onRefresh();
    } catch {
      setDraft(name);
    }
    setRenaming(false);
  };

  const handleRenameKey = (e) => {
    if (e.key === 'Enter')  commitRename();
    if (e.key === 'Escape') { setDraft(name); setRenaming(false); }
  };

  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu(e, {
      isFolder: true,
      triggerRename: () => setRenaming(true),
      doDelete: async () => { await deleteItem(path, true); onRefresh(); },
      doNewFile: async () => {
        if (!open) { toggleOpen(path); await loadChildren(); }
        setPendingNew('file');
      },
      doNewFolder: async () => {
        if (!open) { toggleOpen(path); await loadChildren(); }
        setPendingNew('folder');
      },
    });
  };

  const handleInlineConfirm = async (newName) => {
    try {
      if (pendingNew === 'folder') await createFolder(newName, path);
      else                         await createFile(newName, path);
      setPendingNew(null);
      loadChildren();
    } catch (err) {
      console.error('Create failed', err);
      setPendingNew(null);
    }
  };

  const childPath = (childName) => path ? `${path}/${childName}` : childName;

  return (
    <div className="fe-folder-wrap">
      <div
        ref={nodeRef}
        className={`fe-folder${open ? ' open' : ''}${selected ? ' fe-selected' : ''}${dragOver ? ' fe-drag-over' : ''}`}
        draggable
        onDragStart={handleDragStart}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }}
        onDragLeave={(e) => { e.stopPropagation(); setDragOver(false); }}
        onDrop={handleDrop}
        onContextMenu={handleContextMenu}
      >
        <span className="fe-chevron" onClick={toggle} />
        <span className="fe-folder-icon" onClick={toggle}>
          {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
        </span>
        <span className="fe-item-label" onClick={toggle}>
          {renaming
            ? <input className="fe-rename-input" value={draft} autoFocus
                onChange={e => setDraft(sanitizeName(e.target.value))}
                onKeyDown={handleRenameKey}
                onBlur={commitRename}
                onClick={e => e.stopPropagation()}
              />
            : name
          }
        </span>
      </div>

      {open && (
        <div className="fe-children">
          {pendingNew && (
            <InlineCreate
              type={pendingNew}
              onConfirm={handleInlineConfirm}
              onCancel={() => setPendingNew(null)}
            />
          )}
          {loading && <span className="fe-loading">Loading…</span>}
          {!loading && children.map(item =>
            item.type === 'folder'
              ? <FolderNode key={item.name} name={item.name} path={childPath(item.name)}
                  onRefresh={refresh} onSelect={onSelect} selectedPath={selectedPath}
                  openPaths={openPaths} toggleOpen={toggleOpen} relocatePaths={relocatePaths}
                  onCtxMenu={onCtxMenu} />
              : <FileNode   key={item.name} name={item.name} path={childPath(item.name)}
                  onRefresh={refresh} onSelect={onSelect} selectedPath={selectedPath}
                  onCtxMenu={onCtxMenu} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function FileExplorer({ workspaceName = 'Workspace', onSelect, selectedPath, openPaths, toggleOpen, relocatePaths }) {
  const [items, setItems]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu]   = useState(null);
  const [pendingNew, setPendingNew] = useState(null); // null | 'file' | 'folder'

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  const openCtxMenu  = useCallback((e, config) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, ...config });
  }, []);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    try { setItems(sortItems(await listFolder(''))); }
    catch (err) { console.error('Load root failed', err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadRoot(); }, [loadRoot]);

  const handleCreate = (isFolder) => setPendingNew(isFolder ? 'folder' : 'file');

  const handleRootInlineConfirm = async (newName) => {
    try {
      if (pendingNew === 'folder') await createFolder(newName, '');
      else                         await createFile(newName, '');
      setPendingNew(null);
      loadRoot();
    } catch (err) {
      console.error('Create failed', err);
      setPendingNew(null);
    }
  };

  const handleRootDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const srcPath  = e.dataTransfer.getData('fb-path');
    const isFolder = e.dataTransfer.getData('fb-is-folder') === 'true';
    if (!srcPath) return;
    const srcName = srcPath.replace(/\\/g, '/').split('/').pop();
    if (srcPath.replace(/\\/g, '/') === srcName) return;
    try {
      await moveItem(srcPath, srcName, isFolder);
      if (isFolder) relocatePaths(srcPath, srcName);
      loadRoot();
    } catch (err) { console.error('Move to root failed', err); }
  };

  const handleTreeContextMenu = (e) => {
    e.preventDefault();
    openCtxMenu(e, {
      isRoot: true,
      doNewFile:   () => setPendingNew('file'),
      doNewFolder: () => setPendingNew('folder'),
    });
  };

  const ctxItems = ctxMenu ? [
    ...(ctxMenu.isFolder || ctxMenu.isRoot ? [
      { label: 'New File',   action: ctxMenu.doNewFile   },
      { label: 'New Folder', action: ctxMenu.doNewFolder },
      ...(ctxMenu.isRoot ? [] : [{ separator: true }]),
    ] : []),
    ...(ctxMenu.isRoot ? [] : [
      { label: 'Rename', action: ctxMenu.triggerRename },
      { label: 'Delete', action: ctxMenu.doDelete, danger: true },
    ]),
  ] : [];

  return (
    <div
      className={`fe-root${dragOver ? ' fe-drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleRootDrop}
    >
      <div className="fe-header">
        <span className="fe-workspace-name">{workspaceName}</span>
        <div className="fe-header-actions">
          <button className="fe-action-btn" onClick={() => handleCreate(true)} title="New folder">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.38a1.5 1.5 0 0 1 1.06.44L8 3.5H13.5A1.5 1.5 0 0 1 15 5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12V3.5z"/>
              <line x1="8" y1="7" x2="8" y2="11"/><line x1="6" y1="9" x2="10" y2="9"/>
            </svg>
          </button>
          <button className="fe-action-btn" onClick={() => handleCreate(false)} title="New file">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9A1.5 1.5 0 0 0 14 13.5V6L9 1z"/>
              <polyline points="9,1 9,6 14,6"/>
              <line x1="8" y1="9" x2="8" y2="13"/><line x1="6" y1="11" x2="10" y2="11"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="fe-tree" onContextMenu={handleTreeContextMenu}>
        {pendingNew && (
          <InlineCreate
            type={pendingNew}
            onConfirm={handleRootInlineConfirm}
            onCancel={() => setPendingNew(null)}
          />
        )}
        {loading && <span className="fe-loading">Loading…</span>}
        {!loading && !pendingNew && items.length === 0 && (
          <span className="fe-empty">No files yet — use the buttons above to get started.</span>
        )}
        {!loading && items.map(item =>
          item.type === 'folder'
            ? <FolderNode key={item.name} name={item.name} path={item.name}
                onRefresh={loadRoot} onSelect={onSelect} selectedPath={selectedPath}
                openPaths={openPaths} toggleOpen={toggleOpen} relocatePaths={relocatePaths}
                onCtxMenu={openCtxMenu} />
            : <FileNode   key={item.name} name={item.name} path={item.name}
                onRefresh={loadRoot} onSelect={onSelect} selectedPath={selectedPath}
                onCtxMenu={openCtxMenu} />
        )}
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={closeCtxMenu} />
      )}
    </div>
  );
}
