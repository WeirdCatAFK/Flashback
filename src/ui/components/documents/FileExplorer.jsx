import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { listFolder, createFile, createFolder, deleteItem, moveItem, renameItem, importFileWithProgress, getEntityTags, getTags, getSidecar, updateMetadata } from '../../api/documents';
import IconFolder from '../icons/IconFolder';
import IconFolderOpen from '../icons/IconFolderOpen';
import IconFile from '../icons/IconFile';
import getFileIcon from '../icons/fileIconMap';
import ContextMenu from '../shared/ContextMenu';
import ProgressDialog from '../shared/ProgressDialog';
import './FileExplorer.css';

const sortItems = (items) =>
  items.toSorted((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

// Strip characters Windows forbids in filenames: \ / : * ? " < > |
const sanitizeName = (s) => s.replace(/[\\/:*?"<>|]/g, '');

// Names reserved by the data model (see DATAMODEL.md): the per-folder `media`
// asset directory and `.flashback` metadata sidecars are managed automatically
// and can't be created by hand. Returns an error message, or null if allowed.
const reservedNameError = (name, type) => {
  const lower = name.trim().toLowerCase();
  if (lower === '.flashback' || lower.endsWith('.flashback'))
    return 'The ".flashback" name is reserved for Flashback metadata and can\'t be created directly.';
  if (type === 'folder' && lower === 'media')
    return 'The "media" folder name is reserved for flashcard assets and is managed automatically.';
  return null;
};

// ── Tag chip input (shared with FolderTagsModal) ──────────────────────────────

function TagChipInput({ tags, onAdd, onRemove, allKnownTags = [], placeholder = 'Add tag…', chipClass = '' }) {
  const [input, setInput] = useState('');
  const [open, setOpen]   = useState(false);

  const suggestions = input.trim()
    ? allKnownTags.filter(t => t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t)).slice(0, 8)
    : allKnownTags.filter(t => !tags.includes(t)).slice(0, 8);

  const addTag = (name) => {
    const t = name.trim();
    if (t && !tags.includes(t)) onAdd(t);
    setInput('');
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter')     { e.preventDefault(); if (input.trim()) addTag(input); }
    if (e.key === 'Escape')    { setOpen(false); setInput(''); }
    if (e.key === 'Backspace' && !input && tags.length > 0) onRemove(tags[tags.length - 1]);
  };

  return (
    <div className="tci-wrap">
      <div className={`tci-row${open && suggestions.length > 0 ? ' tci-row--open' : ''}`}>
        {tags.map(t => (
          <span key={t} className={`tag-chip ${chipClass}`}>
            {t}
            <button type="button" className="tag-chip-remove" onClick={() => onRemove(t)}>×</button>
          </span>
        ))}
        <input
          className="tci-input"
          value={input}
          placeholder={tags.length === 0 ? placeholder : ''}
          onChange={e => { setInput(e.target.value); setOpen(true); }}
          onKeyDown={handleKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul className="tci-dropdown">
          {suggestions.map(s => (
            <li key={s} className="tci-suggestion" onMouseDown={() => addTag(s)}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Folder swatch modal ───────────────────────────────────────────────────────

const SWATCH_PRESETS = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899'];

function FolderSwatchModal({ path, currentColor, onClose, onSaved }) {
  const [custom, setCustom]   = useState(currentColor || '#3b82f6');
  const [saving, setSaving]   = useState(false);

  const apply = async (color) => {
    setSaving(true);
    try {
      const sidecar = await getSidecar(path, true);
      await updateMetadata(path, { ...(sidecar || {}), swatchColor: color }, true);
      onSaved(); // parent closes the modal and triggers refresh
    } catch {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fsm-backdrop" onClick={onClose}>
      <div className="fsm-modal" onClick={e => e.stopPropagation()}>
        <div className="fsm-header">
          <span className="fsm-title">Folder color</span>
          <button type="button" className="ftm-close" onClick={onClose}>×</button>
        </div>
        <div className="fsm-swatches">
          <button
            type="button"
            className={`fsm-swatch fsm-swatch--none${!currentColor ? ' fsm-swatch--active' : ''}`}
            title="No color"
            disabled={saving}
            onClick={() => apply('')}
          />
          {SWATCH_PRESETS.map(c => (
            <button
              key={c}
              type="button"
              className={`fsm-swatch${currentColor === c ? ' fsm-swatch--active' : ''}`}
              style={{ background: c }}
              title={c}
              disabled={saving}
              onClick={() => apply(c)}
            />
          ))}
        </div>
        <div className="fsm-custom-row">
          <span className="fsm-custom-label">Custom</span>
          <input
            type="color"
            className="fsm-custom-input"
            value={custom}
            onChange={e => setCustom(e.target.value)}
          />
          <button
            type="button"
            className="tags-btn tags-btn--save"
            disabled={saving}
            onClick={() => apply(custom)}
          >
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Folder tags modal ─────────────────────────────────────────────────────────

function FolderTagsModal({ path, onClose }) {
  const [inherited, setInherited]       = useState([]);
  const [directTags, setDirectTags]     = useState([]);
  const [excludedTags, setExcludedTags] = useState([]);
  const [allKnownTags, setAllKnownTags] = useState([]);
  const [dirty, setDirty]   = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    Promise.all([getEntityTags(path, true), getTags()])
      .then(([entity, { tags: all }]) => {
        if (cancelled) return;
        setInherited(entity.inherited ?? []);
        setDirectTags(entity.direct ?? []);
        setExcludedTags(entity.excluded ?? []);
        setAllKnownTags(all ?? []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path]);

  const addDirect   = (t) => { setDirectTags(p => p.includes(t) ? p : [...p, t]);   setDirty(true); };
  const removeDirect = (t) => { setDirectTags(p => p.filter(x => x !== t));          setDirty(true); };
  const addExcluded  = (t) => { setExcludedTags(p => p.includes(t) ? p : [...p, t]); setDirty(true); };
  const removeExcluded = (t) => { setExcludedTags(p => p.filter(x => x !== t));      setDirty(true); };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const sidecar = await getSidecar(path, true);
      await updateMetadata(path, { ...sidecar, tags: directTags, excludedTags }, true);
      onClose();
    } catch {
      setError('Save failed.');
      setSaving(false);
    }
  };

  return createPortal(
    <div className="ftm-backdrop" onClick={onClose}>
      <div className="ftm-modal" onClick={e => e.stopPropagation()}>
        <div className="ftm-header">
          <span className="ftm-title">Folder tags</span>
          <span className="ftm-path">{path}</span>
          <button type="button" className="ftm-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {inherited.length > 0 && (
          <div className="ftm-section">
            <div className="ftm-label">Inherited <span className="ftm-hint">from parent folders, read-only</span></div>
            <div className="tags-chip-row">
              {inherited.map(t => <span key={t} className="tag-chip tag-chip--inherited">{t}</span>)}
            </div>
          </div>
        )}

        <div className="ftm-section">
          <div className="ftm-label">Direct tags</div>
          <TagChipInput
            tags={directTags}
            onAdd={addDirect}
            onRemove={removeDirect}
            allKnownTags={allKnownTags}
            chipClass="tag-chip--direct"
          />
        </div>

        <div className="ftm-section">
          <div className="ftm-label">
            Excluded tags
            <span className="ftm-hint">block these inherited tags from propagating to children</span>
          </div>
          <TagChipInput
            tags={excludedTags}
            onAdd={addExcluded}
            onRemove={removeExcluded}
            allKnownTags={[...inherited, ...directTags]}
            placeholder="Add exclusion…"
            chipClass="tag-chip--excluded"
          />
        </div>

        {error && <p className="ftm-error">{error}</p>}

        <div className="ftm-footer">
          <button type="button" className="tags-btn tags-btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="tags-btn tags-btn--save" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Inline create input ───────────────────────────────────────────────────────

function InlineCreate({ type, onConfirm, onCancel }) {
  const defaultName = type === 'folder' ? 'New Folder' : 'new_file';
  const [name, setName] = useState(defaultName);
  const committed = useRef(false); // guard against Enter + onBlur both firing commit

  const commit = () => {
    if (committed.current) return;
    const trimmed = name.trim();
    if (!trimmed) { committed.current = true; onCancel(); return; }
    const finalName = type === 'file' ? (trimmed.includes('.') ? trimmed : `${trimmed}.md`) : trimmed;
    const err = reservedNameError(finalName, type);
    if (err) { committed.current = true; window.alert(err); onCancel(); return; }
    committed.current = true;
    onConfirm(finalName);
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
          aria-label="New name"
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

function FileNode({ name, path, globalHash, flashcardCount = 0, onRefresh, onSelect, onDoubleSelect, selectedPath, onCtxMenu }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const FileIcon = getFileIcon(name);
  const selected = path === selectedPath;
  const nodeRef = useRef(null);

  useEffect(() => {
    if (selected) nodeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const handleDragStart = (e) => {
    e.dataTransfer.setData('fb-path', path);
    e.dataTransfer.setData('fb-is-folder', 'false');
    if (globalHash) e.dataTransfer.setData('fb-global-hash', globalHash);
    if (globalHash) e.dataTransfer.setData('fb-file-name', name);
    e.stopPropagation();
  };

  const commitRename = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) { setDraft(name); setRenaming(false); return; }
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
    const base = trimmed.replace(/\.+$/, '');
    const newName = ext && (!trimmed.includes('.') || trimmed.endsWith('.')) ? base + ext : trimmed;
    const err = reservedNameError(newName, 'file');
    if (err) { window.alert(err); setDraft(name); setRenaming(false); return; }
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
      triggerRename: () => { setDraft(name); setRenaming(true); },
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
      onDoubleClick={() => !renaming && onDoubleSelect?.(path)}
      onContextMenu={handleContextMenu}
    >
      <FileIcon size={14} />
      <span className="fe-item-label">
        {renaming
          ? <input className="fe-rename-input" value={draft} autoFocus
              aria-label="New name"
              onChange={e => setDraft(sanitizeName(e.target.value))}
              onKeyDown={handleRenameKey}
              onBlur={commitRename}
              onClick={e => e.stopPropagation()}
            />
          : name
        }
      </span>
      {flashcardCount > 0 && (
        <span className="fe-fc-badge">{flashcardCount}</span>
      )}
    </div>
  );
}

// ── Folder ────────────────────────────────────────────────────────────────────

function FolderNode({ name, path, flashcardCount = 0, swatchColor = '', onRefresh, onSelect, onDoubleSelect, selectedPath, openPaths, toggleOpen, relocatePaths, onCtxMenu, onImportProgress }) {
  const open = openPaths.has(path);
  const selected = path === selectedPath;
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft]       = useState('');
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
  // wasOpenOnMount captures the initial value so later open/close toggles
  // (handled by the toggle() handler directly) don't re-trigger this.
  const wasOpenOnMount = useRef(open);
  useEffect(() => {
    if (wasOpenOnMount.current) loadChildren();
  }, [loadChildren]);

  const toggle = () => {
    if (!open) loadChildren();
    toggleOpen(path);
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

    if (!srcPath) {
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fd = new FormData();
          fd.append('file', file);
          fd.append('name', file.name);
          fd.append('parentPath', path);
          await importFileWithProgress(fd, (pct) =>
            onImportProgress({ done: i, total: files.length, pct, processing: pct >= 100, filename: file.name })
          );
          onImportProgress({ done: i + 1, total: files.length, pct: 0, processing: false, filename: file.name });
        }
        refresh();
      } catch (err) { console.error('Import failed', err); }
      finally { onImportProgress(null); }
      return;
    }

    if (srcPath === path || path.startsWith(srcPath + '/')) return;
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
    const err = reservedNameError(trimmed, 'folder');
    if (err) { window.alert(err); setDraft(name); setRenaming(false); return; }
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
      folderPath: path,
      folderColor: swatchColor,
      doRefreshOnColorSave: refresh,
      triggerRename: () => { setDraft(name); setRenaming(true); },
      doDelete: async () => { await deleteItem(path, true); onRefresh(); },
      doNewFile: async () => {
        if (!open) { toggleOpen(path); await loadChildren(); }
        setPendingNew('file');
      },
      doNewFolder: async () => {
        if (!open) { toggleOpen(path); await loadChildren(); }
        setPendingNew('folder');
      },
      doEditTags: () => {},
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
        {swatchColor && (
          <span className="fe-folder-swatch" style={{ background: swatchColor }} />
        )}
        <span className="fe-folder-icon" onClick={toggle}>
          {open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
        </span>
        <span className="fe-item-label" onClick={toggle}>
          {renaming
            ? <input className="fe-rename-input" value={draft} autoFocus
                aria-label="New name"
                onChange={e => setDraft(sanitizeName(e.target.value))}
                onKeyDown={handleRenameKey}
                onBlur={commitRename}
                onClick={e => e.stopPropagation()}
              />
            : name
          }
        </span>
        {flashcardCount > 0 && (
          <span className="fe-fc-badge">{flashcardCount}</span>
        )}
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
                  flashcardCount={item.flashcardCount ?? 0} swatchColor={item.swatchColor ?? ''}
                  onRefresh={refresh} onSelect={onSelect} onDoubleSelect={onDoubleSelect} selectedPath={selectedPath}
                  openPaths={openPaths} toggleOpen={toggleOpen} relocatePaths={relocatePaths}
                  onCtxMenu={onCtxMenu} onImportProgress={onImportProgress} />
              : <FileNode   key={item.name} name={item.name} path={childPath(item.name)}
                  globalHash={item.metadata?.globalHash}
                  flashcardCount={item.flashcardCount ?? 0}
                  onRefresh={refresh} onSelect={onSelect} onDoubleSelect={onDoubleSelect} selectedPath={selectedPath}
                  onCtxMenu={onCtxMenu} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function FileExplorer({ workspaceName = 'Workspace', onSelect, onDoubleSelect, selectedPath, openPaths, toggleOpen, relocatePaths, onStudyFolder }) {
  const [items, setItems]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu]   = useState(null);
  const [pendingNew, setPendingNew] = useState(null); // null | 'file' | 'folder'
  const [importing, setImporting]   = useState(null); // null | { done, total, pct }
  const [tagsTarget, setTagsTarget]   = useState(null); // folder path being edited
  const [swatchTarget, setSwatchTarget] = useState(null); // { path, color } for color picker
  const swatchRefreshRef = useRef(null);

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

    if (!srcPath) {
      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const fd = new FormData();
          fd.append('file', file);
          fd.append('name', file.name);
          fd.append('parentPath', '');
          await importFileWithProgress(fd, (pct) =>
            setImporting({ done: i, total: files.length, pct, processing: pct >= 100, filename: file.name })
          );
          setImporting({ done: i + 1, total: files.length, pct: 0, processing: false, filename: file.name });
        }
        loadRoot();
      } catch (err) { console.error('Import failed', err); }
      finally { setImporting(null); }
      return;
    }

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
    ...(ctxMenu.isFolder ? [
      { label: 'Study folder', action: () => onStudyFolder?.(ctxMenu.folderPath) },
      { label: 'Edit tags',    action: () => setTagsTarget(ctxMenu.folderPath) },
      { label: 'Set color',    action: () => {
          swatchRefreshRef.current = ctxMenu.doRefreshOnColorSave;
          setSwatchTarget({ path: ctxMenu.folderPath, color: ctxMenu.folderColor ?? '' });
        }
      },
      { separator: true },
    ] : []),
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
          <button type="button" className="fe-action-btn" onClick={() => handleCreate(true)} title="New folder" aria-label="New folder">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.38a1.5 1.5 0 0 1 1.06.44L8 3.5H13.5A1.5 1.5 0 0 1 15 5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12V3.5z"/>
              <line x1="8" y1="7" x2="8" y2="11"/><line x1="6" y1="9" x2="10" y2="9"/>
            </svg>
          </button>
          <button type="button" className="fe-action-btn" onClick={() => handleCreate(false)} title="New file" aria-label="New file">
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
                flashcardCount={item.flashcardCount ?? 0} swatchColor={item.swatchColor ?? ''}
                onRefresh={loadRoot} onSelect={onSelect} onDoubleSelect={onDoubleSelect} selectedPath={selectedPath}
                openPaths={openPaths} toggleOpen={toggleOpen} relocatePaths={relocatePaths}
                onCtxMenu={openCtxMenu} onImportProgress={setImporting} />
            : <FileNode   key={item.name} name={item.name} path={item.name}
                globalHash={item.metadata?.globalHash}
                flashcardCount={item.flashcardCount ?? 0}
                onRefresh={loadRoot} onSelect={onSelect} onDoubleSelect={onDoubleSelect} selectedPath={selectedPath}
                onCtxMenu={openCtxMenu} />
        )}
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={closeCtxMenu} />
      )}

      {importing && (
        <ProgressDialog
          title={importing.total === 1 ? 'Importing file' : `Importing file ${importing.done + 1} of ${importing.total}`}
          filename={importing.filename}
          progress={((importing.done + importing.pct / 100) / importing.total) * 100}
          processing={importing.processing}
          statusText={importing.processing ? 'Processing…' : `Uploading… ${importing.pct}%`}
        />
      )}

      {tagsTarget && (
        <FolderTagsModal path={tagsTarget} onClose={() => setTagsTarget(null)} />
      )}

      {swatchTarget && (
        <FolderSwatchModal
          path={swatchTarget.path}
          currentColor={swatchTarget.color}
          onClose={() => setSwatchTarget(null)}
          onSaved={() => { swatchRefreshRef.current?.(); setSwatchTarget(null); }}
        />
      )}
    </div>
  );
}
