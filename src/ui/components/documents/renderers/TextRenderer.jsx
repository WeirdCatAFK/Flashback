import { EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  ThemedHighlight,
  highlightsFromText,
  applyHighlightsToText,
} from './highlights';
import { useHighlightableRenderer } from './useHighlightableRenderer';
import ConflictBanner from '../../shared/ConflictBanner';
import { useRef } from 'react';
import { useScrollProgress } from './useScrollProgress';
import { useT } from '../../../translations';
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

export default function TextRenderer({ initialProgress, onProgress, progressRef, ...props }) {
  const { t } = useT();
  const containerRef = useRef(null);
  const { editor, loading, conflict, reloadFromDisk, overwrite } = useHighlightableRenderer({
    ...props,
    extensions: EXTENSIONS,
    editorClass: 'text-tiptap',
    serialize,
    loadContent,
    reconcile: highlightsFromText,
  });

  useScrollProgress({
    elementRef: containerRef,
    path: props.path,
    length: editor && !loading ? editor.getText().length : 0,
    ready: !!editor && !loading,
    initialProgress,
    onProgress,
    progressRef,
  });

  return (
    <div className="text-tiptap-container" ref={containerRef}>
      {conflict && <ConflictBanner onReload={reloadFromDisk} onOverwrite={overwrite} />}
      {loading && <div className="renderer-loading">{t('Loading…')}</div>}
      <EditorContent editor={editor} className="text-tiptap-wrapper" />
    </div>
  );
}

// Capabilities (editable / supportsHighlight) are declared in renderers/registry.js,
// not as statics here: this component is loaded lazily and the parent needs both
// answers before the chunk arrives.
