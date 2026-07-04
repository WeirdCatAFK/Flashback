import { EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  ThemedHighlight,
  highlightsFromText,
  applyHighlightsToText,
} from './highlights';
import { useHighlightableRenderer } from './useHighlightableRenderer';
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

const EXTENSIONS = [PLAIN_TEXT, ThemedHighlight.configure({ multicolor: true })];

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

// Body and highlights load together: set the text, then re-anchor the stored
// offset-based highlights onto it.
const loadContent = (editor, text, meta) => {
  editor.commands.setContent(textToDoc(text), false);
  applyHighlightsToText(editor, meta.highlights ?? []);
};

export default function TextRenderer(props) {
  const { editor, loading } = useHighlightableRenderer({
    ...props,
    extensions: EXTENSIONS,
    editorClass: 'text-tiptap',
    serialize,
    loadContent,
    reconcile: highlightsFromText,
  });

  return (
    <div className="text-tiptap-container">
      {loading && <div className="renderer-loading">Loading…</div>}
      <EditorContent editor={editor} className="text-tiptap-wrapper" />
    </div>
  );
}

// Participates in the document-highlight system (offset-anchored). DocumentEditor
// reads this flag to enable the highlight toolbar.
TextRenderer.supportsHighlight = true;
// Text content is user-editable, so DocumentEditor shows a Save button for it.
TextRenderer.editable = true;
