import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { listFolder, createFile, createFolder, deleteItem, moveItem, renameItem, importFileWithProgress, importZipWithProgress, applyAnkiMapping, getEntityTags, getTags, getSidecar, updateMetadata, clipUrl, clipYoutube } from '../../api/documents';
import IconFolder from '../icons/IconFolder';
import IconFolderOpen from '../icons/IconFolderOpen';
import IconFile from '../icons/IconFile';
import getFileIcon from '../icons/fileIconMap';
import ContextMenu from '../shared/ContextMenu';
import { useSession } from '../../sessionContext.js';
import ProgressDialog from '../shared/ProgressDialog';
import TagChipInput from '../shared/TagChipInput';
import Modal from '../shared/Modal';
import AnkiMappingModal from '../shared/AnkiMappingModal';
import { useDataInvalidation, invalidateData } from '../../utils/dataBus';
import { useT } from '../../translations';
import './FileExplorer.css';

const sortItems = (items) =>
  items.toSorted((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

// Strip characters Windows forbids in filenames: \ / : * ? " < > |
const sanitizeName = (s) => s.replace(/[\\/:*?"<>|]/g, '');

// The context menu is assembled from role-gated groups, each ending in a separator. Drop the
// ones that no longer divide anything — a Reader would otherwise get a menu made mostly of
// rules. Collapses runs and trims both ends, so the groups themselves stay declarative.
const dropDanglingSeparators = (items) => {
  const out = [];
  for (const item of items) {
    if (!item?.separator) { out.push(item); continue; }
    if (out.length && !out[out.length - 1].separator) out.push(item);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
};

// Names reserved by the data model (see DATAMODEL.md): the per-folder `media`
// asset directory and `.flashback` metadata sidecars are managed automatically
// and can't be created by hand. Returns an error message, or null if allowed.
const reservedNameError = (name, type, t) => {
  const lower = name.trim().toLowerCase();
  if (lower === '.flashback' || lower.endsWith('.flashback'))
    return t('The ".flashback" name is reserved for Flashback metadata and can’t be created directly.');
  if (type === 'folder' && lower === 'media')
    return t('The "media" folder name is reserved for flashcard assets and is managed automatically.');
  return null;
};

// ── Folder swatch modal ───────────────────────────────────────────────────────

const SWATCH_PRESETS = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899'];

function FolderSwatchModal({ path, currentColor, onClose, onSaved }) {
  const { t } = useT();
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
          <span className="fsm-title">{t('Folder color')}</span>
          <button type="button" className="ftm-close" onClick={onClose}>×</button>
        </div>
        <div className="fsm-swatches">
          <button
            type="button"
            className={`fsm-swatch fsm-swatch--none${!currentColor ? ' fsm-swatch--active' : ''}`}
            title={t('No color')}
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
          <span className="fsm-custom-label">{t('Custom')}</span>
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
            {t('Apply')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Folder tags modal ─────────────────────────────────────────────────────────

function FolderTagsModal({ path, onClose }) {
  const { t } = useT();
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

  const addDirect   = (tag) => { setDirectTags(p => p.includes(tag) ? p : [...p, tag]);   setDirty(true); };
  const removeDirect = (tag) => { setDirectTags(p => p.filter(x => x !== tag));            setDirty(true); };
  const addExcluded  = (tag) => { setExcludedTags(p => p.includes(tag) ? p : [...p, tag]); setDirty(true); };
  const removeExcluded = (tag) => { setExcludedTags(p => p.filter(x => x !== tag));        setDirty(true); };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const sidecar = await getSidecar(path, true);
      await updateMetadata(path, { ...sidecar, tags: directTags, excludedTags }, true);
      onClose();
    } catch {
      setError(t('Save failed.'));
      setSaving(false);
    }
  };

  return createPortal(
    <div className="ftm-backdrop" onClick={onClose}>
      <div className="ftm-modal" onClick={e => e.stopPropagation()}>
        <div className="ftm-header">
          <span className="ftm-title">{t('Folder tags')}</span>
          <span className="ftm-path">{path}</span>
          <button type="button" className="ftm-close" onClick={onClose} aria-label={t('Close')}>×</button>
        </div>

        {inherited.length > 0 && (
          <div className="ftm-section">
            <div className="ftm-label">
              {t('Inherited')} <span className="ftm-hint">{t('from parent folders, read-only')}</span>
            </div>
            <div className="tags-chip-row">
              {inherited.map(tag => <span key={tag} className="tag-chip tag-chip--inherited">{tag}</span>)}
            </div>
          </div>
        )}

        <div className="ftm-section">
          <div className="ftm-label">{t('Direct tags')}</div>
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
            {t('Excluded tags')}
            <span className="ftm-hint">{t('block these inherited tags from propagating to children')}</span>
          </div>
          <TagChipInput
            tags={excludedTags}
            onAdd={addExcluded}
            onRemove={removeExcluded}
            allKnownTags={[...inherited, ...directTags]}
            placeholder={t('Add exclusion…')}
            chipClass="tag-chip--excluded"
          />
        </div>

        {error && <p className="ftm-error">{error}</p>}

        <div className="ftm-footer">
          <button type="button" className="tags-btn tags-btn--ghost" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="tags-btn tags-btn--save" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? t('Saving…') : t('Save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Inline create input ───────────────────────────────────────────────────────

function InlineCreate({ type, onConfirm, onCancel }) {
  const { t } = useT();
  // These become real names on disk, but they are pre-selected in the input for the
  // user to type over, so they read as prompts and are translated like one.
  const defaultName = type === 'folder' ? t('New Folder') : t('new_file');
  const [name, setName] = useState(defaultName);
  const committed = useRef(false); // guard against Enter + onBlur both firing commit

  const commit = () => {
    if (committed.current) return;
    const trimmed = name.trim();
    if (!trimmed) { committed.current = true; onCancel(); return; }
    const finalName = type === 'file' ? (trimmed.includes('.') ? trimmed : `${trimmed}.md`) : trimmed;
    const err = reservedNameError(finalName, type, t);
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
          aria-label={t('New name')}
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

function FileNode({ name, path, globalHash, flashcardCount = 0, onRefresh, onSelect, onDoubleSelect, selectedPath, relocatePaths, onCtxMenu }) {
  const { t } = useT();
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
    const err = reservedNameError(newName, 'file', t);
    if (err) { window.alert(err); setDraft(name); setRenaming(false); return; }
    try {
      await renameItem(path, newName, false);
      // Keep an open tab/draft for this file pointing at its new name.
      relocatePaths?.(path, path.slice(0, path.length - name.length) + newName);
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
              aria-label={t('New name')}
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

function FolderNode({ name, path, flashcardCount = 0, swatchColor = '', onRefresh, onSelect, onDoubleSelect, selectedPath, openPaths, toggleOpen, relocatePaths, onCtxMenu, onImportProgress, onNeedsMapping }) {
  const { t } = useT();
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
          if (file.name.toLowerCase().endsWith('.zip') || file.name.toLowerCase().endsWith('.apkg')) {
            fd.append('targetPath', path);
            const result = await importZipWithProgress(fd, (pct) =>
              onImportProgress({ done: i, total: files.length, pct, processing: pct >= 100, filename: file.name })
            );
            // Anki packages need a field→slot mapping before anything is created.
            if (result?.needsMapping) {
              onNeedsMapping?.({ report: result, filename: file.name });
              continue;
            }
          } else {
            fd.append('parentPath', path);
            await importFileWithProgress(fd, (pct) =>
              onImportProgress({ done: i, total: files.length, pct, processing: pct >= 100, filename: file.name })
            );
          }
          onImportProgress({ done: i + 1, total: files.length, pct: 0, processing: false, filename: file.name });
        }
        refresh();
        invalidateData(); // also reload Decks/Flashcards/graph, not just this folder
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
      relocatePaths(srcPath, destPath);
      refresh();
    } catch (err) { console.error('Move failed', err); }
  };

  const commitRename = async () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) { setDraft(name); setRenaming(false); return; }
    const err = reservedNameError(trimmed, 'folder', t);
    if (err) { window.alert(err); setDraft(name); setRenaming(false); return; }
    try {
      await renameItem(path, trimmed, true);
      // Replace the final path segment so open tabs/drafts under this folder follow the rename.
      relocatePaths(path, path.slice(0, path.length - name.length) + trimmed);
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
                aria-label={t('New name')}
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
          {loading && <span className="fe-loading">{t('Loading…')}</span>}
          {!loading && children.map(item =>
            item.type === 'folder'
              ? <FolderNode key={item.name} name={item.name} path={childPath(item.name)}
                  flashcardCount={item.flashcardCount ?? 0} swatchColor={item.swatchColor ?? ''}
                  onRefresh={refresh} onSelect={onSelect} onDoubleSelect={onDoubleSelect} selectedPath={selectedPath}
                  openPaths={openPaths} toggleOpen={toggleOpen} relocatePaths={relocatePaths}
                  onCtxMenu={onCtxMenu} onImportProgress={onImportProgress} onNeedsMapping={onNeedsMapping} />
              : <FileNode   key={item.name} name={item.name} path={childPath(item.name)}
                  globalHash={item.metadata?.globalHash}
                  flashcardCount={item.flashcardCount ?? 0}
                  onRefresh={refresh} onSelect={onSelect} onDoubleSelect={onDoubleSelect} selectedPath={selectedPath}
                  relocatePaths={relocatePaths}
                  onCtxMenu={onCtxMenu} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Clip-from-URL modal ───────────────────────────────────────────────────────

const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be)$/i;
const looksLikeYoutube = (url) => {
  try { return YOUTUBE_HOST.test(new URL(url).hostname); } catch { return false; }
};

// Captures a web article (.clip) or a YouTube reference (.youtube) into the
// target folder. Kind auto-detects from the host but can be overridden.
function ClipUrlModal({ targetPath, onClose, onCreated }) {
  const { t } = useT();
  const [url, setUrl]     = useState('');
  const [kind, setKind]   = useState('auto'); // 'auto' | 'article' | 'youtube'
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  const effectiveKind = kind === 'auto' ? (looksLikeYoutube(url) ? 'youtube' : 'article') : kind;

  const submit = async () => {
    const u = url.trim();
    if (!u || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = effectiveKind === 'youtube'
        ? await clipYoutube(u, targetPath)
        : await clipUrl(u, targetPath);
      onCreated(result?.path);
    } catch (err) {
      setError(err?.message || t('Could not capture that URL.'));
      setBusy(false);
    }
  };

  const onKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };

  return (
    <Modal
      title={t('Clip from URL')}
      size="sm"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="clip-btn" onClick={onClose} disabled={busy}>{t('Cancel')}</button>
          <button type="button" className="clip-btn clip-btn--primary" onClick={submit} disabled={busy || !url.trim()}>
            {busy ? t('Clipping…') : t('Clip')}
          </button>
        </>
      }
    >
      <div className="clip-form">
        <label className="clip-field">
          <span className="clip-label">{t('Page or video URL')}</span>
          <input
            className="clip-input"
            type="url"
            inputMode="url"
            placeholder="https://…"
            value={url}
            autoFocus
            disabled={busy}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
        <div className="clip-kind" role="radiogroup" aria-label={t('Capture as')}>
          {[
            ['auto', t('Auto')],
            ['article', t('Article')],
            ['youtube', t('YouTube')],
          ].map(([val, lbl]) => (
            <button
              key={val}
              type="button"
              role="radio"
              aria-checked={kind === val}
              className={`clip-kind-btn${kind === val ? ' clip-kind-btn--active' : ''}`}
              disabled={busy}
              onClick={() => setKind(val)}
            >
              {lbl}
            </button>
          ))}
        </div>
        <p className="clip-hint">
          {kind === 'auto'
            ? (effectiveKind === 'youtube'
              ? t('Auto-detected: YouTube video.')
              : t('Auto-detected: web article.'))
            : effectiveKind === 'youtube'
              ? t('Stores the video reference with timestamp highlights.')
              : t('Fetches and stores a readable snapshot of the page.')}
        </p>
        {error && <p className="clip-error">{error}</p>}
      </div>
    </Modal>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function FileExplorer({ workspaceName = 'Workspace', onSelect, onDoubleSelect, selectedPath, openPaths, toggleOpen, relocatePaths, onStudyFolder }) {
  const { t } = useT();
  const { can } = useSession();
  const [items, setItems]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [rootError, setRootError] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [ctxMenu, setCtxMenu]   = useState(null);
  const [pendingNew, setPendingNew] = useState(null); // null | 'file' | 'folder'
  const [importing, setImporting]   = useState(null); // null | { done, total, pct }
  const [ankiMapping, setAnkiMapping] = useState(null); // null | { report, filename }
  const [ankiBusy, setAnkiBusy]       = useState(false);
  const [ankiError, setAnkiError]     = useState(null);
  const [tagsTarget, setTagsTarget]   = useState(null); // folder path being edited
  const [swatchTarget, setSwatchTarget] = useState(null); // { path, color } for color picker
  const [clipTarget, setClipTarget] = useState(null); // { path } destination folder for Clip-from-URL
  const swatchRefreshRef = useRef(null);
  const clipRefreshRef = useRef(null);
  const fileInputRef = useRef(null);
  const ctxMenuTargetRef = useRef('');

  // Open the Clip-from-URL dialog targeting `path`; `refresh` re-lists that folder on success.
  const openClip = useCallback((path, refresh) => {
    clipRefreshRef.current = refresh || null;
    setClipTarget({ path: path || '' });
  }, []);

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);
  const openCtxMenu  = useCallback((e, config) => {
    setCtxMenu({ x: e.clientX, y: e.clientY, ...config });
  }, []);

  const handleImportFiles = async (files, parent = '') => {
    if (!files || !files.length) return;
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fd = new FormData();
        fd.append('file', file);
        fd.append('name', file.name);
        if (file.name.toLowerCase().endsWith('.zip') || file.name.toLowerCase().endsWith('.apkg')) {
          fd.append('targetPath', parent);
          const result = await importZipWithProgress(fd, (pct) =>
            setImporting({ done: i, total: files.length, pct, processing: pct >= 100, filename: file.name })
          );
          // Anki packages need a field→slot mapping before anything is created.
          if (result?.needsMapping) {
            setAnkiMapping({ report: result, filename: file.name });
            continue;
          }
        } else {
          fd.append('parentPath', parent);
          await importFileWithProgress(fd, (pct) =>
            setImporting({ done: i, total: files.length, pct, processing: pct >= 100, filename: file.name })
          );
        }
        setImporting({ done: i + 1, total: files.length, pct: 0, processing: false, filename: file.name });
      }
      // Broadcast so Decks, Flashcards and the graph reload too — not just this
      // tree. Our own useDataInvalidation subscriber handles loadRoot() + the
      // treeVersion bump that remounts subtrees (imports can create nested dirs).
      invalidateData();
    } catch (err) { console.error('Import failed', err); }
    finally { setImporting(null); }
  };

  const handleApplyAnkiMapping = async (mappings) => {
    setAnkiBusy(true);
    setAnkiError(null);
    try {
      await applyAnkiMapping(ankiMapping.report.sessionId, mappings);
      setAnkiMapping(null);
      invalidateData();
    } catch (err) {
      console.error('Anki import failed', err);
      setAnkiError(err.message || t('The import failed. Pick the file again to retry.'));
    } finally {
      setAnkiBusy(false);
    }
  };

  const handleFilePickerChange = (e) => {
    const files = Array.from(e.target.files || []);
    handleImportFiles(files, ctxMenuTargetRef.current || '');
    e.target.value = ''; // Reset
  };

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setRootError(false);
    try { setItems(sortItems(await listFolder(''))); }
    catch (err) { console.error('Load root failed', err); setRootError(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadRoot(); }, [loadRoot]);

  // After a Seal rollback / Vault Doctor sync, the files on disk were rewritten.
  // Reload the root listing and bump treeVersion so every open FolderNode remounts
  // and re-fetches its children (FolderNode reloads on mount when it starts open).
  const [treeVersion, setTreeVersion] = useState(0);
  useDataInvalidation(() => { loadRoot(); setTreeVersion(v => v + 1); });

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
      if (!can('importDocuments')) return;
      const files = Array.from(e.dataTransfer.files);
      await handleImportFiles(files, '');
      return;
    }
    // A drop is a move; a drag that only reordered the view would be a lie about what landed.
    if (!can('changeVaultShape')) return;

    const srcName = srcPath.replace(/\\/g, '/').split('/').pop();
    if (srcPath.replace(/\\/g, '/') === srcName) return;
    try {
      await moveItem(srcPath, srcName, isFolder);
      relocatePaths(srcPath, srcName);
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

  // Gated by role. On a local vault every capability answers true, so this is the same menu
  // it has always been; on a server a Reader is left with "Study folder" and nothing that
  // would 403. Hidden rather than disabled — a context menu of dead entries is worse than a
  // short one (see the hide/disable rule in the M5 plan).
  const ctxItems = ctxMenu ? dropDanglingSeparators([
    ...(ctxMenu.isFolder ? [
      { label: t('Study folder'), action: () => onStudyFolder?.(ctxMenu.folderPath) },
      ...(can('annotate') ? [
        { label: t('Edit tags'),    action: () => setTagsTarget(ctxMenu.folderPath) },
        { label: t('Set color'),    action: () => {
            swatchRefreshRef.current = ctxMenu.doRefreshOnColorSave;
            setSwatchTarget({ path: ctxMenu.folderPath, color: ctxMenu.folderColor ?? '' });
          }
        },
      ] : []),
      ...(can('importDocuments') ? [
        { label: t('Import to folder'), action: () => {
            ctxMenuTargetRef.current = ctxMenu.folderPath;
            fileInputRef.current?.click();
          }
        },
      ] : []),
      { separator: true },
    ] : []),
    ...((ctxMenu.isFolder || ctxMenu.isRoot) && can('createDocuments') ? [
      { label: t('New File'),   action: ctxMenu.doNewFile   },
      { label: t('New Folder'), action: ctxMenu.doNewFolder },
      { label: t('Clip from URL'), action: () => openClip(ctxMenu.isRoot ? '' : ctxMenu.folderPath, ctxMenu.isRoot ? loadRoot : ctxMenu.doRefreshOnColorSave) },
      ...(ctxMenu.isRoot && can('importDocuments') ? [
        { label: t('Import files/packages'), action: () => {
            ctxMenuTargetRef.current = '';
            fileInputRef.current?.click();
          }
        },
      ] : []),
      { separator: true },
    ] : []),
    ...(ctxMenu.isRoot || !can('changeVaultShape') ? [] : [
      { label: t('Rename'), action: ctxMenu.triggerRename },
      { label: t('Delete'), action: ctxMenu.doDelete, danger: true },
    ]),
  ]) : [];

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
          {/* Hidden, not disabled: a Reader's sidebar should read as a reading sidebar. The
              same capabilities gate the context menu below, so the two can't disagree. */}
          {can('createDocuments') && (
          <button type="button" className="fe-action-btn" onClick={() => handleCreate(true)} title={t('New folder')} aria-label={t('New folder')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.38a1.5 1.5 0 0 1 1.06.44L8 3.5H13.5A1.5 1.5 0 0 1 15 5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12V3.5z"/>
              <line x1="8" y1="7" x2="8" y2="11"/><line x1="6" y1="9" x2="10" y2="9"/>
            </svg>
          </button>
          )}
          {can('createDocuments') && (
          <button type="button" className="fe-action-btn" onClick={() => handleCreate(false)} title={t('New file')} aria-label={t('New file')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9A1.5 1.5 0 0 0 14 13.5V6L9 1z"/>
              <polyline points="9,1 9,6 14,6"/>
              <line x1="8" y1="9" x2="8" y2="13"/><line x1="6" y1="11" x2="10" y2="11"/>
            </svg>
          </button>
          )}
          {can('importDocuments') && (
          <button type="button" className="fe-action-btn" onClick={() => { ctxMenuTargetRef.current = ''; fileInputRef.current?.click(); }} title={t('Import files / packages (.zip, .apkg, .md)')} aria-label={t('Import files')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M12 12L8 8L4 12"/>
              <line x1="8" y1="8" x2="8" y2="15"/>
              <rect x="2" y="2" width="12" height="4" rx="1"/>
            </svg>
          </button>
          )}
          {can('createDocuments') && (
          <button type="button" className="fe-action-btn" onClick={() => openClip('', loadRoot)} title={t('Clip from URL (web article or YouTube)')} aria-label={t('Clip from URL')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6.5 9.5a2.5 2.5 0 0 0 3.6.1l2.4-2.4a2.5 2.5 0 1 0-3.5-3.5l-1 1"/>
              <path d="M9.5 6.5a2.5 2.5 0 0 0-3.6-.1L3.5 8.8a2.5 2.5 0 1 0 3.5 3.5l1-1"/>
            </svg>
          </button>
          )}
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
        {loading && <span className="fe-loading">{t('Loading…')}</span>}
        {!loading && rootError && (
          <span className="fe-empty fe-empty--error">
            {t("Couldn't load your files.")}
            <button type="button" className="fe-retry" onClick={loadRoot}>{t('Try again')}</button>
          </span>
        )}
        {!loading && !rootError && !pendingNew && items.length === 0 && (
          <span className="fe-empty">{t('No files yet — use the buttons above to get started.')}</span>
        )}
        {!loading && items.map(item =>
          item.type === 'folder'
            ? <FolderNode key={`${item.name}:${treeVersion}`} name={item.name} path={item.name}
                flashcardCount={item.flashcardCount ?? 0} swatchColor={item.swatchColor ?? ''}
                onRefresh={loadRoot} onSelect={onSelect} onDoubleSelect={onDoubleSelect} selectedPath={selectedPath}
                openPaths={openPaths} toggleOpen={toggleOpen} relocatePaths={relocatePaths}
                onCtxMenu={openCtxMenu} onImportProgress={setImporting} onNeedsMapping={setAnkiMapping} />
            : <FileNode   key={item.name} name={item.name} path={item.name}
                globalHash={item.metadata?.globalHash}
                flashcardCount={item.flashcardCount ?? 0}
                onRefresh={loadRoot} onSelect={onSelect} onDoubleSelect={onDoubleSelect} selectedPath={selectedPath}
                relocatePaths={relocatePaths}
                onCtxMenu={openCtxMenu} />
        )}
      </div>

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={closeCtxMenu} />
      )}

      {importing && (
        <ProgressDialog
          title={importing.total === 1
            ? t('Importing file')
            : t('Importing file {index} of {total}', { index: importing.done + 1, total: importing.total })}
          filename={importing.filename}
          progress={((importing.done + importing.pct / 100) / importing.total) * 100}
          processing={importing.processing}
          statusText={importing.processing
            ? t('Processing…')
            : t('Uploading… {percent}%', { percent: importing.pct })}
        />
      )}

      {ankiMapping && (
        <AnkiMappingModal
          report={ankiMapping.report}
          filename={ankiMapping.filename}
          importing={ankiBusy}
          error={ankiError}
          onCancel={() => { setAnkiMapping(null); setAnkiError(null); }}
          onConfirm={handleApplyAnkiMapping}
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

      {clipTarget && (
        <ClipUrlModal
          targetPath={clipTarget.path}
          onClose={() => setClipTarget(null)}
          onCreated={(newPath) => {
            clipRefreshRef.current?.();
            setClipTarget(null);
            if (newPath) onDoubleSelect?.(newPath.replace(/\\/g, '/'));
          }}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        style={{ display: 'none' }}
        multiple
        accept=".zip,.apkg,.md,.txt,.pdf,.epub"
        onChange={handleFilePickerChange}
        aria-label={t('Upload files')}
      />
    </div>
  );
}
