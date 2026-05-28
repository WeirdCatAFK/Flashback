import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { readFile, updateFile } from '../../../api/documents';
import {
  ThemedHighlight,
  createHighlightCommands,
  reconcileHighlights,
} from './highlights';
import './MarkdownRenderer.css';

export default function MarkdownRenderer({
  path,
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
    extensions: [
      StarterKit,
      Typography,
      ThemedHighlight.configure({ multicolor: true }),
      Markdown.configure({ html: true, linkify: true, breaks: false }),
    ],
    content: '',
    editorProps: { attributes: { class: 'tiptap-editor' } },
    onUpdate: ({ editor }) => {
      if (loadingIntoEditorRef.current) return;
      const md = editor.storage.markdown.getMarkdown();
      if (!isDirtyRef.current) {
        isDirtyRef.current = true;
        onDirtyChange?.(pathRef.current, true);
      }
      onDraftChange?.(pathRef.current, md);
    },
  });

  // Save handler — reconciles highlight registry, writes content + sidecar.
  // The merge base is re-read from disk every save so concurrent sidecar edits
  // (e.g. a card added via the Inspector) are never clobbered. An optional
  // metaTransform lets callers mutate that base first (e.g. delete cards).
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async (metaTransform) => {
    if (!editor) return;
    const savedPath = pathRef.current;
    // Never persist if this file's content never loaded — the editor would be
    // showing its empty initial state, and saving it would erase the file.
    if (loadedPathRef.current !== savedPath) return;
    try {
      const md = editor.storage.markdown.getMarkdown();
      let baseMeta = {};
      try { baseMeta = (await readFile(savedPath)).metadata ?? {}; } catch { /* new/unsynced file */ }
      if (metaTransform) baseMeta = metaTransform(baseMeta);
      const { highlights } = reconcileHighlights(editor, baseMeta.highlights ?? []);
      const nextMeta = { ...baseMeta, highlights };
      await updateFile(savedPath, md, nextMeta);
      isDirtyRef.current = false;
      onDirtyChange?.(savedPath, false);
      onDraftChange?.(savedPath, undefined);
      onHighlightsChange?.(savedPath, highlights);
      onSidecarRefresh?.(savedPath, nextMeta);
    } catch {
      // dirty dot stays; user can retry with Ctrl+S
    }
  };

  useEffect(() => {
    if (saveRef) saveRef.current = (metaTransform) => handleSaveRef.current?.(metaTransform);
    return () => { if (saveRef) saveRef.current = null; };
  });

  // Expose highlight commands to parent (SelectionToolbar lives in DocumentEditor)
  useEffect(() => {
    if (!highlightRef || !editor) return;
    highlightRef.current = createHighlightCommands(editor);
    return () => { if (highlightRef) highlightRef.current = null; };
  }, [editor, highlightRef]);

  // Load file (or draft) into the existing editor whenever path changes
  useEffect(() => {
    if (!editor || !path) return;
    let isMounted = true;
    const draft = draftRef.current;
    const targetPath = path;
    // A fresh path is unloaded until proven otherwise — block saves until the
    // content lands. (Don't clear other paths' flag; switching back to an
    // already-loaded tab still relies on the prior load.)
    if (loadedPathRef.current === targetPath) loadedPathRef.current = null;

    const apply = (markdown, isDraft, metadata) => {
      if (!isMounted || pathRef.current !== targetPath) return;
      const meta = metadata ?? {};
      loadingIntoEditorRef.current = true;
      editor.commands.setContent(markdown ?? '', false);
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

  return (
    <div className="markdown-editor-container">
      <div className="editor-content-wrapper">
        {loading && (
          <div className="editor-loading-overlay">Loading Editor…</div>
        )}
        <EditorContent editor={editor} className="tiptap-wrapper" />
      </div>
    </div>
  );
}
