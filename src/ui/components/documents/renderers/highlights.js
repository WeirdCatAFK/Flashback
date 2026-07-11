// Helpers for the document-highlight registry that lives in each .flashback
// sidecar.
//
// Two anchoring strategies share one registry shape (`highlights[]`):
//   • Markdown — the highlight lives inline in the body as
//     `<mark data-color=… data-hl=…>`; the registry mirrors it (DOM-based here).
//   • Plain text (.txt) — the body can't carry markup, so the registry entry
//     also stores character offsets (`start`/`end`); marks are re-applied from
//     those offsets on load and recomputed from live positions on save.
//
// Both produce/consume the same entry fields (id, color, text, cardHashes,
// refIds, timestamps); the offset fields are simply absent for markdown.

import Highlight from '@tiptap/extension-highlight';

const TEXT_SNAPSHOT_LIMIT = 240;

function generateHighlightId() {
  // 9 base36 chars ≈ 47 bits — plenty for per-document uniqueness, short
  // enough that the inline HTML doesn't bloat the markdown source.
  const rand = (typeof crypto !== 'undefined' && crypto.getRandomValues)
    ? crypto.getRandomValues(new Uint32Array(2))
    : [Math.floor(Math.random() * 2 ** 32), Math.floor(Math.random() * 2 ** 32)];
  return 'h_' + (rand[0].toString(36) + rand[1].toString(36)).slice(0, 9);
}

function snapshot(text) {
  const trimmed = (text ?? '').trim();
  return trimmed.length > TEXT_SNAPSHOT_LIMIT
    ? trimmed.slice(0, TEXT_SNAPSHOT_LIMIT - 1) + '…'
    : trimmed;
}

// Shared Highlight mark. Two attribute changes from the upstream default:
//   data-color — emitted via class-tinted CSS variables, no inline style
//   data-hl    — stable per-highlight ID anchoring it to the sidecar entry
export const ThemedHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-color'),
        renderHTML: (attrs) => (attrs.color ? { 'data-color': attrs.color } : {}),
      },
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-hl'),
        renderHTML: (attrs) => (attrs.id ? { 'data-hl': attrs.id } : {}),
      },
    };
  },
});

// Selection-driven highlight commands shared by every editor-backed renderer.
// Returns the object stored on DocumentEditor's highlightRef.
export function createHighlightCommands(editor) {
  return {
    // 'created' — new highlight added | 'recolored' — same id, new color
    // 'existing' — same color clicked again, no-op | null — no selection
    // Removal is only ever explicit (unset via the toolbar's × button), which
    // is the path that confirms before severing a highlight with linked cards.
    toggle: (color) => {
      if (!editor || editor.state.selection.empty) return null;
      const current = editor.getAttributes('highlight');
      if (current.color === color && current.id) {
        return { kind: 'existing', id: current.id };
      }
      const chain = editor.chain().focus();
      if (current.color && current.id) {
        chain.setHighlight({ color, id: current.id }).run();
        return { kind: 'recolored', id: current.id };
      }
      const id = generateHighlightId();
      chain.setHighlight({ color, id }).run();
      return { kind: 'created', id };
    },
    unset: () => {
      if (!editor) return null;
      const current = editor.getAttributes('highlight');
      if (!current.id) return null;
      editor.chain().focus().unsetHighlight().run();
      return { kind: 'removed', id: current.id };
    },
    // Remove a highlight by registry id regardless of the current selection —
    // used by the Highlights tab's delete button.
    remove: (id) => {
      if (!editor || !id) return null;
      const markType = editor.schema.marks.highlight;
      if (!markType) return null;
      let tr = editor.state.tr;
      let found = false;
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type === markType && m.attrs.id === id);
        if (mark) {
          tr = tr.removeMark(pos, pos + node.nodeSize, markType);
          found = true;
        }
      });
      if (!found) return null;
      editor.view.dispatch(tr);
      return { kind: 'removed', id };
    },
    // Ensure the selection is highlighted without changing an existing color.
    // Used by the Card / Ref buttons, which always want an anchor.
    ensure: (color = 'amber') => {
      if (!editor || editor.state.selection.empty) return null;
      const current = editor.getAttributes('highlight');
      if (current.id) return { kind: 'existing', id: current.id };
      const id = generateHighlightId();
      editor.chain().focus().setHighlight({ color, id }).run();
      return { kind: 'created', id };
    },
    currentId: () => editor?.getAttributes('highlight').id ?? null,
    scrollTo: (id) => editor && scrollToHighlight(editor, id),
  };
}

// Merge a freshly-collected map of live marks with the sidecar's prior entries,
// preserving fields we don't own (cardHashes, refIds, createdAt).
//   current: Map<id, { color, text, ...extra }>   (extra = {start,end} for txt)
function mergeRegistry(current, existing = []) {
  const now = new Date().toISOString();
  const next = [];
  const seen = new Set();
  const removed = [];

  for (const entry of existing) {
    if (!entry?.id) continue;
    if (current.has(entry.id)) {
      const live = current.get(entry.id);
      next.push({
        ...entry,
        ...live,
        color: live.color ?? entry.color ?? null,
        text: snapshot(live.text),
        updatedAt: now,
      });
      seen.add(entry.id);
    } else {
      removed.push(entry);
    }
  }

  for (const [id, live] of current) {
    if (seen.has(id)) continue;
    next.push({
      id,
      ...live,
      color: live.color ?? null,
      text: snapshot(live.text),
      createdAt: now,
      updatedAt: now,
      cardHashes: [],
      refIds: [],
    });
  }

  return { highlights: next, removed };
}

// ── Markdown (DOM-anchored) ────────────────────────────────────────────────

// Walk the editor's DOM and return every <mark data-hl=…> by ID.
function collectMarks(editor) {
  const out = new Map();
  const root = editor?.view?.dom;
  if (!root) return out;
  root.querySelectorAll('mark[data-hl]').forEach((el) => {
    const id = el.getAttribute('data-hl');
    if (!id) return;
    const prev = out.get(id);
    if (prev) {
      prev.text += el.textContent ?? '';
    } else {
      out.set(id, { color: el.getAttribute('data-color') ?? null, text: el.textContent ?? '' });
    }
  });
  return out;
}

export function reconcileHighlights(editor, existing = []) {
  return mergeRegistry(collectMarks(editor), existing);
}

// ── Plain text (offset-anchored) ───────────────────────────────────────────

// The document body for a .txt file is the editor's text with paragraphs
// joined by '\n' — this is exactly what gets written to disk, so highlight
// offsets index into it.
function plainText(editor) {
  return editor.getText({ blockSeparator: '\n' });
}

// Map each text node to its [char offset, ProseMirror position] start, matching
// the '\n'-joined serialization above.
function buildTextIndex(doc) {
  const segments = [];
  let charPos = 0;
  doc.forEach((block, blockPos, index) => {
    if (index > 0) charPos += 1; // the '\n' separator between blocks
    block.forEach((child, childOffset) => {
      if (child.isText) {
        segments.push({ charStart: charPos, pmStart: blockPos + 1 + childOffset, length: child.text.length });
        charPos += child.text.length;
      }
    });
  });
  return segments;
}

function charToPM(segments, offset) {
  for (const seg of segments) {
    if (offset >= seg.charStart && offset <= seg.charStart + seg.length) {
      return seg.pmStart + (offset - seg.charStart);
    }
  }
  return null;
}

// Recompute the registry from the live mark positions in a plain-text doc.
export function highlightsFromText(editor, existing = []) {
  const current = new Map();
  let charPos = 0;
  editor.state.doc.forEach((block, _pos, index) => {
    if (index > 0) charPos += 1;
    block.forEach((child) => {
      if (child.isText) {
        const hl = child.marks.find((m) => m.type.name === 'highlight');
        if (hl?.attrs?.id) {
          const id = hl.attrs.id;
          const prev = current.get(id);
          if (prev) {
            const gap = charPos - prev.end;
            if (gap > 0) prev.text += '\n'.repeat(gap); // approximate separators
            prev.text += child.text;
            prev.end = charPos + child.text.length;
          } else {
            current.set(id, {
              color: hl.attrs.color ?? null,
              text: child.text,
              start: charPos,
              end: charPos + child.text.length,
            });
          }
        }
        charPos += child.text.length;
      }
    });
  });
  return mergeRegistry(current, existing);
}

// Re-apply stored highlights to a freshly-loaded plain-text doc. Verifies each
// against its text snapshot; if the offsets no longer match (file edited
// elsewhere) it re-anchors by searching for the quote, or drops it if gone.
export function applyHighlightsToText(editor, highlights = []) {
  if (!highlights.length) return;
  const segments = buildTextIndex(editor.state.doc);
  const fullText = plainText(editor);
  const markType = editor.schema.marks.highlight;
  if (!markType) return;

  let tr = editor.state.tr;
  let changed = false;
  for (const h of highlights) {
    let { start, end } = h;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    const quote = h.text ?? '';
    if (quote && fullText.slice(start, end) !== quote) {
      const found = fullText.indexOf(quote);
      if (found === -1) continue; // can't anchor → drop
      start = found;
      end = found + quote.length;
    }
    const from = charToPM(segments, start);
    const to = charToPM(segments, end);
    if (from == null || to == null || to <= from) continue;
    tr = tr.addMark(from, to, markType.create({ id: h.id, color: h.color }));
    changed = true;
  }
  if (changed) {
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
  }
}

// Scroll the editor view to the mark with the given ID. Returns true if found.
function scrollToHighlight(editor, id) {
  const el = editor?.view?.dom?.querySelector(`mark[data-hl="${id}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}
