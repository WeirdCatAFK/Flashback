import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import { readFile, updateFile } from '../../../api/documents';
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
}) {
  const [loading, setLoading] = useState(true);

  const isDirtyRef = useRef(false);
  const loadingIntoEditorRef = useRef(false);
  const draftRef = useRef(draftContent);
  draftRef.current = draftContent;
  const pathRef = useRef(path);
  pathRef.current = path;
  // True only once this path's content has actually loaded into the editor.
  // Guards against writing the editor's empty initial state back over a real
  // file when the load failed (API not ready / mid-session blip).
  const loadedPathRef = useRef(null);

  const editor = useEditor({
    extensions,
    content: '',
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

  // Save — re-read the sidecar fresh as the merge base so a concurrent edit
  // (e.g. a card added via the Inspector) is never clobbered, let an optional
  // metaTransform mutate that base (e.g. delete cards on highlight removal),
  // reconcile the highlight registry from the live editor, then write.
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async (metaTransform) => {
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
      await updateFile(savedPath, body, nextMeta);
      isDirtyRef.current = false;
      onDirtyChange?.(savedPath, false);
      onDraftChange?.(savedPath, undefined);
      onHighlightsChange?.(savedPath, highlights);
      onSidecarRefresh?.(savedPath, nextMeta);
    } catch {
      // dirty dot stays; user can retry with Ctrl+S
    }
  };

  // Expose the save handler to the parent (DocumentEditor drives it from the
  // toolbar). metaTransform is forwarded through.
  useEffect(() => {
    if (saveRef) saveRef.current = (metaTransform) => handleSaveRef.current?.(metaTransform);
    return () => { if (saveRef) saveRef.current = null; };
  });

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

    const apply = (body, isDraft, metadata) => {
      if (!isMounted || pathRef.current !== targetPath) return;
      const meta = metadata ?? {};
      loadingIntoEditorRef.current = true;
      loadContent(editor, body, meta);
      loadingIntoEditorRef.current = false;
      isDirtyRef.current = isDraft;
      loadedPathRef.current = targetPath;
      if (!isDraft) onDirtyChange?.(targetPath, false);
      onHighlightsChange?.(targetPath, meta.highlights ?? []);
      onSidecarRefresh?.(targetPath, meta);
      setLoading(false);
    };

    if (draft !== undefined) {
      // Restoring an unsaved draft: the draft is real user content, so apply it
      // even if the sidecar read fails. Read sidecar fresh for highlights/cards.
      readFile(targetPath)
        .then((data) => apply(draft, true, data.metadata))
        .catch(() => apply(draft, true, {}));
      return;
    }

    setLoading(true);
    readFile(targetPath)
      .then((data) => apply(data.content ?? '', false, data.metadata))
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

  return { editor, loading };
}
