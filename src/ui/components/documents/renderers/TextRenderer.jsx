import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { readFile, updateFile } from '../../../api/documents';
import {
  ThemedHighlight,
  createHighlightCommands,
  highlightsFromText,
  applyHighlightsToText,
} from './highlights';
import './Renderer.css';

// Plain-text editor. Same TipTap/ProseMirror foundation as the markdown
// renderer (so highlights track edits live and the whole highlight UI is
// reused), but with every formatting extension disabled — a .txt file must
// stay plain text. Highlights can't be embedded in the body, so they're
// anchored by character offset in the sidecar's highlights[] registry.
const PLAIN_TEXT = StarterKit.configure({
  heading: false,
  bold: false,
  italic: false,
  strike: false,
  code: false,
  codeBlock: false,
  blockquote: false,
  bulletList: false,
  orderedList: false,
  listItem: false,
  horizontalRule: false,
  hardBreak: false, // Enter = new paragraph = '\n'; no soft breaks to serialize
  link: false,
  underline: false,
});

// Build a ProseMirror doc from plain text: one paragraph per line. Avoids the
// HTML-string path so text is never interpreted as markup.
function textToDoc(text) {
  const lines = (text ?? '').split('\n');
  return {
    type: 'doc',
    content: lines.map((line) =>
      line.length
        ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
        : { type: 'paragraph' }
    ),
  };
}

const serialize = (editor) => editor.getText({ blockSeparator: '\n' });

export default function TextRenderer({
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
  // True only once this path's content has loaded — guards against writing the
  // editor's empty initial state back over a real file (see MarkdownRenderer).
  const loadedPathRef = useRef(null);

  const editor = useEditor({
    extensions: [PLAIN_TEXT, ThemedHighlight.configure({ multicolor: true })],
    content: '',
    editorProps: { attributes: { class: 'text-tiptap' } },
    onUpdate: ({ editor }) => {
      if (loadingIntoEditorRef.current) return;
      if (!isDirtyRef.current) {
        isDirtyRef.current = true;
        onDirtyChange?.(pathRef.current, true);
      }
      onDraftChange?.(pathRef.current, serialize(editor));
    },
  });

  // Save — write plain text body + recomputed offset-anchored highlights.
  // Merge base re-read from disk each save so a concurrent sidecar edit (e.g. a
  // card added via the Inspector) isn't clobbered. metaTransform lets callers
  // mutate that base first (e.g. delete cards on highlight removal).
  const handleSaveRef = useRef(null);
  handleSaveRef.current = async (metaTransform) => {
    if (!editor) return;
    const savedPath = pathRef.current;
    if (loadedPathRef.current !== savedPath) return;
    try {
      const text = serialize(editor);
      let baseMeta = {};
      try { baseMeta = (await readFile(savedPath)).metadata ?? {}; } catch { /* new/unsynced */ }
      if (metaTransform) baseMeta = metaTransform(baseMeta);
      const { highlights } = highlightsFromText(editor, baseMeta.highlights ?? []);
      const nextMeta = { ...baseMeta, highlights };
      await updateFile(savedPath, text, nextMeta);
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

  useEffect(() => {
    if (!highlightRef || !editor) return;
    highlightRef.current = createHighlightCommands(editor);
    return () => { if (highlightRef) highlightRef.current = null; };
  }, [editor, highlightRef]);

  // Load file (or draft) into the editor whenever path changes
  useEffect(() => {
    if (!editor || !path) return;
    let isMounted = true;
    const draft = draftRef.current;
    const targetPath = path;
    if (loadedPathRef.current === targetPath) loadedPathRef.current = null;

    const apply = (text, isDraft, metadata) => {
      if (!isMounted || pathRef.current !== targetPath) return;
      const meta = metadata ?? {};
      loadingIntoEditorRef.current = true;
      editor.commands.setContent(textToDoc(text), false);
      applyHighlightsToText(editor, meta.highlights ?? []);
      loadingIntoEditorRef.current = false;
      isDirtyRef.current = isDraft;
      loadedPathRef.current = targetPath;
      if (!isDraft) onDirtyChange?.(targetPath, false);
      onHighlightsChange?.(targetPath, meta.highlights ?? []);
      onSidecarRefresh?.(targetPath, meta);
      setLoading(false);
    };

    if (draft !== undefined) {
      // Draft is real user content; read sidecar fresh for highlights.
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
    <div className="text-tiptap-container">
      {loading && <div className="renderer-loading">Loading…</div>}
      <EditorContent editor={editor} className="text-tiptap-wrapper" />
    </div>
  );
}
