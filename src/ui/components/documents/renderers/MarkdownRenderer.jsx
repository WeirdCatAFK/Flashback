import { useCallback, useEffect } from 'react';
import { EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Typography from '@tiptap/extension-typography';
import { Markdown } from 'tiptap-markdown';
import { ThemedHighlight, reconcileHighlights } from './highlights';
import { useHighlightableRenderer } from './useHighlightableRenderer';
import { getDocumentByHash } from '../../../api/documents';
import './MarkdownRenderer.css';

// tiptap-markdown registers a minimal Link$1 mark (no parseHTML/addAttributes) at
// priority 100. @tiptap/extension-link defaults to priority 1000, which sorts it
// first — Object.fromEntries then lets Link$1 overwrite it, losing <a> parsing.
// Setting priority 50 ensures our extension sorts last and wins the schema slot,
// while tiptap-markdown's serializer still finds the markdown spec via its internal
// name-based lookup (markdownExtensions.find(e => e.name === 'link')).
const MarkdownLink = Link.extend({ priority: 50 });

// What this renderer customizes; everything else (load/save/dirty/draft/
// highlight wiring) is the shared hook. Highlights anchor inline in the body as
// <mark data-hl>, so there's no separate apply step on load — setContent parses
// the marks straight out of the markdown.
const EXTENSIONS = [
  StarterKit,
  Typography,
  ThemedHighlight.configure({ multicolor: true }),
  Markdown.configure({ html: true, linkify: true, breaks: false }),
  // Must come after Markdown so it overrides Link$1 in the schema (see above).
  // protocols: adds 'flashback' to isAllowedUri's allowlist (parseHTML rejects
  // unknown protocols otherwise). HTMLAttributes: strip target/_blank so clicks
  // don't open a second tab alongside handleClick's navigation.
  MarkdownLink.configure({
    openOnClick: false,
    protocols: ['flashback'],
    HTMLAttributes: { target: null, rel: null },
  }),
];

const serialize = (editor) => editor.storage.markdown.getMarkdown();
const loadContent = (editor, markdown) => editor.commands.setContent(markdown ?? '', false);

export default function MarkdownRenderer({ onNavigate, ...props }) {
  const { editor, loading } = useHighlightableRenderer({
    ...props,
    extensions: EXTENSIONS,
    editorClass: 'tiptap-editor',
    serialize,
    loadContent,
    reconcile: reconcileHighlights,
  });

  const handleClick = useCallback(async (e) => {
    const anchor = e.target.closest('a[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href?.startsWith('flashback://')) return;
    // Capture phase: prevent browser/Electron navigation and stop ProseMirror
    // from seeing this click (we own flashback:// — ProseMirror should not try
    // to extend the link selection or call window.open).
    e.preventDefault();
    e.stopPropagation();
    const hash = href.slice('flashback://'.length);
    try {
      const doc = await getDocumentByHash(hash);
      onNavigate?.(doc.relativePath);
    } catch { /* hash not yet imported — silently ignore */ }
  }, [onNavigate]);

  // IPC fallback: if a flashback:// link somehow reaches Electron's will-navigate
  // handler (e.g. the capture handler missed it), main.js sends this event.
  useEffect(() => {
    const api = window.flashback;
    if (!api?.onFlashbackNavigate) return;
    return api.onFlashbackNavigate((hash) => {
      getDocumentByHash(hash)
        .then(doc => onNavigate?.(doc.relativePath))
        .catch(() => {});
    });
  }, [onNavigate]);

  const handleDragOver = useCallback((e) => {
    if (e.dataTransfer.types.includes('fb-global-hash')) e.preventDefault();
  }, []);

  const handleDrop = useCallback((e) => {
    const hash = e.dataTransfer.getData('fb-global-hash');
    if (!hash || !editor) return;
    e.preventDefault();
    const name = e.dataTransfer.getData('fb-file-name') || hash;
    editor.chain()
      .focus()
      .insertContent({ type: 'text', text: name, marks: [{ type: 'link', attrs: { href: `flashback://${hash}` } }] })
      .run();
  }, [editor]);

  return (
    <div
      className="markdown-editor-container"
      onClickCapture={handleClick}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
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
