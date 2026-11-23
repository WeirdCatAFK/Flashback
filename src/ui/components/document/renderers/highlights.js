import Highlight from '@tiptap/extension-highlight';

const TEXT_SNAPSHOT_LIMIT = 240;

function generateHighlightId() {
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

export function createHighlightCommands(editor) {
  return {
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
    recolor: (id, color) => {
      if (!editor || !id) return null;
      const markType = editor.schema.marks.highlight;
      if (!markType) return null;
      let tr = editor.state.tr;
      let found = false;
      editor.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        const mark = node.marks.find((m) => m.type === markType && m.attrs.id === id);
        if (mark && mark.attrs.color !== color) {
          tr = tr.removeMark(pos, pos + node.nodeSize, mark).addMark(pos, pos + node.nodeSize, markType.create({ id, color }));
          found = true;
        }
      });
      if (!found) return null;
      editor.view.dispatch(tr);
      return { kind: 'recolored', id };
    },
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

function plainText(editor) {
  return editor.getText({ blockSeparator: '\n' });
}

function buildTextIndex(doc) {
  const segments = [];
  let charPos = 0;
  doc.forEach((block, blockPos, index) => {
    if (index > 0) charPos += 1;
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
            if (gap > 0) prev.text += '\n'.repeat(gap);
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
      if (found === -1) continue;
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

function buildInlineIndex(doc) {
  const parts = [];
  let text = '';
  let prevEnd = null;
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    if (prevEnd !== null && pos > prevEnd) text += '\n';
    parts.push({ charStart: text.length, pmStart: pos, length: node.text.length });
    text += node.text;
    prevEnd = pos + node.nodeSize;
    return true;
  });
  return { text, parts };
}

function inlineCharToPM(parts, offset) {
  for (const p of parts) {
    if (offset >= p.charStart && offset <= p.charStart + p.length) {
      return p.pmStart + (offset - p.charStart);
    }
  }
  return null;
}

function findQuote(text, quote) {
  let idx = text.indexOf(quote);
  if (idx !== -1) return { start: idx, end: idx + quote.length };
  const stripped = quote.replace(/[*_`~]/g, '');
  if (stripped !== quote && stripped.trim()) {
    idx = text.indexOf(stripped);
    if (idx !== -1) return { start: idx, end: idx + stripped.length };
  }
  return null;
}

export function applyMissingHighlights(editor, highlights = []) {
  if (!highlights.length) return;
  const markType = editor.schema.marks.highlight;
  if (!markType) return;

  const present = new Set();
  editor.state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type === markType && m.attrs.id) present.add(m.attrs.id);
    }
    return true;
  });

  const missing = highlights.filter((h) => h?.id && h.text && !present.has(h.id));
  if (!missing.length) return;

  const { text, parts } = buildInlineIndex(editor.state.doc);
  let tr = editor.state.tr;
  let changed = false;
  for (const h of missing) {
    const range = findQuote(text, h.text);
    if (!range) continue;
    const from = inlineCharToPM(parts, range.start);
    const to = inlineCharToPM(parts, range.end);
    if (from == null || to == null || to <= from) continue;
    tr = tr.addMark(from, to, markType.create({ id: h.id, color: h.color ?? 'amber' }));
    changed = true;
  }
  if (changed) {
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
  }
}

function scrollToHighlight(editor, id) {
  const el = editor?.view?.dom?.querySelector(`mark[data-hl="${id}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}
