import { EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { ThemedHighlight, reconcileHighlights } from './highlights';
import { useHighlightableRenderer } from './useHighlightableRenderer';
import './MarkdownRenderer.css';

// What this renderer customizes; everything else (load/save/dirty/draft/
// highlight wiring) is the shared hook. Highlights anchor inline in the body as
// <mark data-hl>, so there's no separate apply step on load — setContent parses
// the marks straight out of the markdown.
const EXTENSIONS = [
  StarterKit,
  Typography,
  ThemedHighlight.configure({ multicolor: true }),
  Markdown.configure({ html: true, linkify: true, breaks: false }),
];

const serialize = (editor) => editor.storage.markdown.getMarkdown();
const loadContent = (editor, markdown) => editor.commands.setContent(markdown ?? '', false);

export default function MarkdownRenderer(props) {
  const { editor, loading } = useHighlightableRenderer({
    ...props,
    extensions: EXTENSIONS,
    editorClass: 'tiptap-editor',
    serialize,
    loadContent,
    reconcile: reconcileHighlights,
  });

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

// This renderer participates in the document-highlight system (see
// useHighlightableRenderer); DocumentEditor reads this flag to enable the
// highlight toolbar without knowing the renderer's identity.
MarkdownRenderer.supportsHighlight = true;
