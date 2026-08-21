import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import { readFile, updateFile } from '../../../api/documents';
import { isStale } from '../../../api/client';
import { createHighlightCommands } from './highlights';

// Shared lifecycle for every editor-backed renderer that participates in the
// document-highlight system. It owns everything that is identical across
// renderers — dirty/draft tracking, the empty-state save guard, the save
// pipeline (re-read sidecar → reconcile highlights → write), highlight-command
// wiring, and Ctrl+S — and delegates the three things that actually differ to
// the caller:
//
//   serialize(editor)            → the document body string written to disk
//   loadContent(editor, body, meta) → put body (and any anchored highlights)
//                                     into the editor; called inside the
//                                     loading guard so it never marks dirty
//   reconcile(editor, existing)  → recompute the highlights[] registry from the
//                                     live editor, returning { highlights }
//
// A new renderer (PDF, code, …) only writes those three functions plus its own
// `extensions`/markup; all the plumbing below is reused unchanged.
//
// Returns { editor, loading } — the caller renders its own <EditorContent> so
// each renderer keeps full control of its wrapper markup and CSS.
export function useHighlightableRenderer({
  path,
  extensions,
  editorClass,
  serialize,
  loadContent,
  reconcile,
  onDirtyChange,
  saveRef,
  highlightRef,
  onHighlightsChange,
  onSidecarRefresh,
  draftContent,
  onDraftChange,
  readOnly = false,
}) {
  const [loading, setLoading] = useState(true);

  const isDirtyRef = useRef(false);
  const loadingIntoEditorRef = useRef(false);
  const draftRef = useRef(draftContent);
  draftRef.current = draftContent;
  const pathRef = useRef(path);
  pathRef.current = path;

  // Stable refs for the function props used inside the load effect.
  // Adding them directly to the dep array would cause the editor to reload
  // whenever a parent callback reference changes (e.g. on every render of
  // DocumentEditor when activeTab is in the useCallback deps).
  const loadContentRef = useRef(loadContent);
  loadContentRef.current = loadContent;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onHighlightsChangeRef = useRef(onHighlightsChange);
  onHighlightsChangeRef.current = onHighlightsChange;
  const onSidecarRefreshRef = useRef(onSidecarRefresh);
  onSidecarRefreshRef.current = onSidecarRefresh;
  // True only once this path's content has actually loaded into the editor.
  // Guards against writing the editor's empty initial state back over a real
  // file when the load failed (API not ready / mid-session blip).
  const loadedPathRef = useRef(null);
  // The document version this editor's body is based on — captured when the
  // content was loaded, NOT re-read at save time, because the whole question a
  // save asks is "has anything changed since I started typing?". Sent back as
  // ifMatch; the server compares only the body half, so a card someone added
  // through the Inspector meanwhile is merged rather than treated as a clash.
  const loadedEtagRef = useRef(null);
  const [conflict, setConflict] = useState(null);

  const editor = useEditor({
    extensions,
    content: '',
    // Read-only when the caller's role cannot write a document body. Enforced here rather
    // than by hiding the Save button alone: a writable editor whose save is refused invites
    // someone to type a page and lose it.
    editable: !readOnly,
    editorProps: { attributes: { class: editorClass } },
    onUpdate: ({ editor }) => {
      if (loadingIntoEditorRef.current) return;
      if (!isDirtyRef.current) {
        isDirtyRef.current = true;
        onDirtyChange?.(pathRef.current, true);
      }
      onDraftChange?.(pathRef.current, serialize(editor));
    },
  });

  // Show loading immediately in the same render that path or editor changes —
  // not one render later when the effect fires — so no flash of stale file content.
  const [prevPathForLoad, setPrevPathForLoad] = useState(path);
  const [prevEditorForLoad, setPrevEditorForLoad] = useState(editor);
  if (prevPathForLoad !== path || prevEditorForLoad !== editor) {
    setPrevPathForLoad(path);
    setPrevEditorForLoad(editor);
    if (path && editor) setLoading(true);
  }

  // Save — re-read the sidecar fresh as the merge base so a concurrent edit
  // (e.g. a card added via the Inspector) is never clobbered, let an optional
  // metaTransform mutate that base (e.g. delete cards on highlight removal),
  // reconcile the highlight registry from the live editor, then write.
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async (metaTransform, { force = false } = {}) => {
    if (!editor) return;
    const savedPath = pathRef.current;
    // Never persist if this file's content never loaded — the editor would be
    // showing its empty initial state, and saving it would erase the file.
    if (loadedPathRef.current !== savedPath) return;
    try {
      const body = serialize(editor);
      let baseMeta = {};
      try { baseMeta = (await readFile(savedPath)).metadata ?? {}; } catch { /* new/unsynced file */ }
      if (metaTransform) baseMeta = metaTransform(baseMeta);
      const { highlights } = reconcile(editor, baseMeta.highlights ?? []);
      const nextMeta = { ...baseMeta, highlights };
      const res = await updateFile(savedPath, body, nextMeta, {
        // `force` skips the check: it is how Overwrite below deliberately wins.
        ifMatch: force ? undefined : loadedEtagRef.current,
      });
      loadedEtagRef.current = res?.etag ?? null;
      setConflict(null);
      isDirtyRef.current = false;
      onDirtyChange?.(savedPath, false);
      onDraftChange?.(savedPath, undefined);
      onHighlightsChange?.(savedPath, highlights);
      onSidecarRefresh?.(savedPath, nextMeta);
    } catch (err) {
      // The draft stays in the editor either way — it is the user's typing, and
      // losing it to a failed save would be the very thing this guards against.
      if (isStale(err)) setConflict({ path: savedPath, etag: err.etag ?? null });
      // Otherwise the dirty dot stays and the user can retry with Ctrl+S.
    }
  };

  // Expose the save handler to the parent (DocumentEditor drives it from the
  // toolbar). metaTransform is forwarded through.
  useEffect(() => {
    if (saveRef) saveRef.current = (metaTransform) => handleSaveRef.current?.(metaTransform);
    return () => { if (saveRef) saveRef.current = null; };
  });

  // Reload: throw this editor's draft away and take what is on disk now.
  const reloadFromDisk = async () => {
    const targetPath = pathRef.current;
    if (!editor || !targetPath) return;
    const data = await readFile(targetPath).catch(() => null);
    if (!data || pathRef.current !== targetPath) return;
    loadingIntoEditorRef.current = true;
    loadContentRef.current(editor, data.content ?? '', data.metadata ?? {});
    loadingIntoEditorRef.current = false;
    loadedEtagRef.current = data.etag ?? null;
    isDirtyRef.current = false;
    setConflict(null);
    onDirtyChangeRef.current?.(targetPath, false);
    onDraftChange?.(targetPath, undefined);
    onSidecarRefreshRef.current?.(targetPath, data.metadata ?? {});
  };

  // Overwrite: the user has decided their version wins. Re-send without a
  // version, which is the same unchecked write every pre-M3 client makes.
  const overwrite = () => handleSaveRef.current?.(undefined, { force: true });

  // Expose highlight commands to the parent (the SelectionToolbar lives in
  // DocumentEditor, which only ever talks to this command object).
  useEffect(() => {
    if (!highlightRef || !editor) return;
    highlightRef.current = createHighlightCommands(editor);
    return () => { if (highlightRef) highlightRef.current = null; };
  }, [editor, highlightRef]);

  // Load file (or unsaved draft) into the existing editor whenever path changes.
  useEffect(() => {
    if (!editor || !path) return;
    let isMounted = true;
    const draft = draftRef.current;
    const targetPath = path;
    // A fresh path is unloaded until proven otherwise — block saves until the
    // content lands. (Don't clear other paths' flag; switching back to an
    // already-loaded tab still relies on the prior load.)
    if (loadedPathRef.current === targetPath) loadedPathRef.current = null;

    const apply = (body, isDraft, metadata, etag = null) => {
      if (!isMounted || pathRef.current !== targetPath) return;
      const meta = metadata ?? {};
      loadedEtagRef.current = etag;
      setConflict(null);
      loadingIntoEditorRef.current = true;
      loadContentRef.current(editor, body, meta);
      loadingIntoEditorRef.current = false;
      isDirtyRef.current = isDraft;
      loadedPathRef.current = targetPath;
      if (!isDraft) onDirtyChangeRef.current?.(targetPath, false);
      onHighlightsChangeRef.current?.(targetPath, meta.highlights ?? []);
      onSidecarRefreshRef.current?.(targetPath, meta);
      setLoading(false);
    };

    if (draft !== undefined) {
      // Restoring an unsaved draft: the draft is real user content, so apply it
      // even if the sidecar read fails. Read sidecar fresh for highlights/cards.
      readFile(targetPath)
        .then((data) => apply(draft, true, data.metadata, data.etag))
        .catch(() => apply(draft, true, {}, null));
      return;
    }

    readFile(targetPath)
      .then((data) => apply(data.content ?? '', false, data.metadata, data.etag))
      .catch(() => { if (isMounted) setLoading(false); });

    return () => { isMounted = false; };
  }, [editor, path]);

  // Ctrl+S anywhere on the page
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSaveRef.current?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return { editor, loading, conflict, reloadFromDisk, overwrite };
}
