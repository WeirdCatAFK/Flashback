import { EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  ThemedHighlight,
  highlightsFromText,
  applyHighlightsToText,
} from '../highlights';
import { useHighlightableRenderer } from '../useHighlightableRenderer';
import ConflictBanner from '../../../base/ConflictBanner';
import { useRef } from 'react';
import { useScrollProgress } from '../useScrollProgress';
import { useT } from '../../../../translations/index';
import '../Renderer.css';

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
  hardBreak: false,
  link: false,
  underline: false,
});

const EXTENSIONS = [PLAIN_TEXT, ThemedHighlight.configure({ multicolor: true })];

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

