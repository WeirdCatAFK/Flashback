import { useCallback, useEffect } from 'react';
import { EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { mergeAttributes } from '@tiptap/core';
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
//
// renderHTML override: flashback:// links MUST NOT appear in href — Chromium
// passes any unregistered protocol to the OS shell (shell.openExternal) before
// JavaScript event handlers fire, so preventDefault() is useless. Storing the
// hash in data-flashback-hash and omitting href entirely prevents this.
const MarkdownLink = Link.extend({
  priority: 50,
  renderHTML({ HTMLAttributes }) {
    const href = HTMLAttributes.href ?? '';
    if (href.startsWith('flashback://')) {
      return ['a', mergeAttributes(this.options.HTMLAttributes, {
        ...HTMLAttributes,
        href: undefined,
        'data-flashback-hash': href.slice('flashback://'.length),
      }), 0];
    }
    // Regular links: delegate to @tiptap/extension-link's standard logic
    const allowed = !this.options.isAllowedUri || this.options.isAllowedUri(href, {
      defaultValidate: () => !!href,
      protocols: this.options.protocols,
    });
    return ['a', mergeAttributes(this.options.HTMLAttributes, allowed ? HTMLAttributes : { ...HTMLAttributes, href: '' }), 0];
  },
});

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
  // protocols: adds 'flashback' to isAllowedUri's allowlist so parseHTML accepts
  // the href during load. HTMLAttributes: strip target/_blank for regular links.
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
    // flashback:// links render with data-flashback-hash (no href) so Chromium
    // never sees the protocol and can't pass it to shell.openExternal.
    const el = e.target.closest('[data-flashback-hash]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const hash = el.dataset.flashbackHash;
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
// Text content is user-editable, so DocumentEditor shows a Save button for it.
MarkdownRenderer.editable = true;
