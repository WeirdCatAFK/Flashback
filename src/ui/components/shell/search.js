const PREFIX_RE = /^(tag|deck|doc|in):(.*)$/i;
const TYPES = [['folder', 'folders'], ['document', 'documents'], ['flashcard', 'flashcards'], ['tag', 'tags'], ['deck', 'decks']];

export function parseQuery(raw) {
  const m = raw.match(PREFIX_RE);
  if (!m) return { q: raw, tag: null, deck: null, document: null, folder: null, prefix: null, value: null };
  const prefix = m[1].toLowerCase();
  const value = m[2];
  return {
    tag: prefix === 'tag' ? value : null,
    deck: prefix === 'deck' ? value : null,
    document: prefix === 'doc' ? value : null,
    folder: prefix === 'in' ? value : null,
    q: null,
    prefix,
    value,
  };
}

export const isEmptyPrefix = (parsed) => parsed.prefix !== null && !parsed.value?.trim();

export function snippet(text, maxLen = 80) {
  if (!text) return '';
  const s = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

export function flattenResults(results) {
  if (!results) return [];
  const out = [];
  for (const [type, key] of TYPES) for (const r of results[key] ?? []) out.push({ ...r, type });
  return out;
}

export function groupResults(results) {
  if (!results || (results.flashcards && !results.folders)) return null;
  const groups = [];
  let offset = 0;
  for (const [type, key] of TYPES) {
    const items = results[key];
    if (items?.length) {
      groups.push({ type, items: items.map((r) => ({ ...r, type })), offset });
      offset += items.length;
    }
  }
  return groups;
}

export function resultLines(item) {
  switch (item.type) {
    case 'folder':
    case 'document': return { primary: item.name, secondary: item.path };
    case 'flashcard': return { primary: item.name || snippet(item.frontText) || item.global_hash.slice(0, 8), secondary: item.document_name || '' };
    default: return { primary: item.name, secondary: '' };
  }
}

export function navigationFor(item) {
  switch (item.type) {
    case 'folder': return { type: 'folder', payload: { path: item.path } };
    case 'document': return { type: 'document', payload: { path: item.path } };
    case 'flashcard': return { type: 'flashcard', payload: { documentPath: item.document_path, globalHash: item.global_hash } };
    case 'tag': return { type: 'tag', payload: { name: item.name } };
    case 'deck': return { type: 'deck', payload: { hash: item.global_hash, name: item.name } };
    default: return null;
  }
}
