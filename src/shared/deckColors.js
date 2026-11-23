export const DECK_COLORS = ['slate', 'sage', 'ochre', 'brick', 'plum', 'ink'];

export const isDeckColor = (c) => DECK_COLORS.includes(c);

export function deckColor({ is_system: isSystem, color, global_hash: hash } = {}) {
  if (isSystem) return 'kraft';
  if (isDeckColor(color)) return color;
  let h = 0;
  for (const ch of String(hash ?? '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return DECK_COLORS[h % DECK_COLORS.length];
}

export function nextDeckColor(used) {
  return DECK_COLORS.find((c) => !used.includes(c)) ?? DECK_COLORS[used.length % DECK_COLORS.length];
}
