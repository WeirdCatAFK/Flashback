/**
 * The lifecycle every TipTap-based renderer shares: load the file and its
 * sidecar, reconcile highlights with the body, track dirty and draft state,
 * detect a stale etag and save on Ctrl+S, and serve the highlight command
 * contract.
 */

import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import { readFile, updateFile } from '../../../api/documents';
import { isStale } from '../../../api/client';
import { createHighlightCommands } from './highlights';

/**
 * Shared lifecycle for every editor-backed renderer that participates in the
 * document-highlight system. It owns everything that is identical across
 * renderers — dirty/draft tracking, the empty-state save guard, the save
 * pipeline (re-read sidecar → reconcile highlights → write), highlight-command
 * wiring, and Ctrl+S — and delegates the three things that actually differ to
 * the caller:
 *
 * serialize(editor)            → the document body string written to disk
 * loadContent(editor, body, meta) → put body (and any anchored highlights)
 * into the editor; called inside the
 * loading guard so it never marks dirty
 * reconcile(editor, existing)  → recompute the highlights[] registry from the
 * live editor, returning { highlights }
 *
 * A new renderer (PDF, code, …) only writes those three functions plus its own
 * `extensions`/markup; all the plumbing below is reused unchanged.
 *
 * Returns { editor, loading } — the caller renders its own <EditorContent> so
 * each renderer keeps full control of its wrapper markup and CSS.
 */
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

  const loadContentRef = useRef(loadContent);
  loadContentRef.current = loadContent;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onHighlightsChangeRef = useRef(onHighlightsChange);
  onHighlightsChangeRef.current = onHighlightsChange;
  const onSidecarRefreshRef = useRef(onSidecarRefresh);
  onSidecarRefreshRef.current = onSidecarRefresh;
  const loadedPathRef = useRef(null);
  const loadedEtagRef = useRef(null);
  const [conflict, setConflict] = useState(null);

  const editor = useEditor({
    extensions,
    content: '',
    editable: !readOnly,
    editorProps: { attributes: { class: editorClass, 'data-column': '' } },
    onUpdate: ({ editor }) => {
      if (loadingIntoEditorRef.current) return;
      if (!isDirtyRef.current) {
        isDirtyRef.current = true;
        onDirtyChange?.(pathRef.current, true);
      }
      onDraftChange?.(pathRef.current, serialize(editor));
    },
  });

  const [prevPathForLoad, setPrevPathForLoad] = useState(path);
  const [prevEditorForLoad, setPrevEditorForLoad] = useState(editor);
  if (prevPathForLoad !== path || prevEditorForLoad !== editor) {
    setPrevPathForLoad(path);
    setPrevEditorForLoad(editor);
    if (path && editor) setLoading(true);
  }

  const handleSaveRef = useRef(null);
  handleSaveRef.current = async (metaTransform, { force = false } = {}) => {
    if (!editor) return;
    const savedPath = pathRef.current;
    if (loadedPathRef.current !== savedPath) return;
    try {
      const body = serialize(editor);
      let baseMeta = {};
      try { baseMeta = (await readFile(savedPath)).metadata ?? {}; } catch { }
      if (metaTransform) baseMeta = metaTransform(baseMeta);
      const { highlights } = reconcile(editor, baseMeta.highlights ?? []);
      const nextMeta = { ...baseMeta, highlights };
      const res = await updateFile(savedPath, body, nextMeta, {
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
      if (isStale(err)) setConflict({ path: savedPath, etag: err.etag ?? null });
    }
  };

  useEffect(() => {
    if (saveRef) saveRef.current = (metaTransform) => handleSaveRef.current?.(metaTransform);
    return () => { if (saveRef) saveRef.current = null; };
  });

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

  const overwrite = () => handleSaveRef.current?.(undefined, { force: true });

  useEffect(() => {
    if (!highlightRef || !editor) return;
    highlightRef.current = createHighlightCommands(editor);
    return () => { if (highlightRef) highlightRef.current = null; };
  }, [editor, highlightRef]);

  useEffect(() => {
    if (!editor || !path) return;
    let isMounted = true;
    const draft = draftRef.current;
    const targetPath = path;
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
