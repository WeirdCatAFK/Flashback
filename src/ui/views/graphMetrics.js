export const HALO_BASE = 11;
export const HALO_K = 4;
export const HALO_MAX = 90;

export function haloRadius(mass) {
  const m = Number(mass);
  if (!isFinite(m) || m <= 0) return HALO_BASE;
  return Math.min(HALO_MAX, HALO_BASE + HALO_K * Math.sqrt(m));
}

export function collideRadius(node, nodeR = 7) {
  return nodeR + 5 + 0.35 * (haloRadius(node?.mass) - HALO_BASE);
}

const idOf = (v) => (typeof v === 'object' && v !== null ? v.id : v);

export function aggregateMass(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map();

  const membersOf = new Map();
  for (const e of edges) {
    if (e.relation !== 'tag' && e.relation !== 'deck') continue;
    const a = byId.get(idOf(e.fromId ?? e.source));
    const b = byId.get(idOf(e.toId ?? e.target));
    if (!a || !b) continue;

    const wanted = e.relation === 'tag' ? 'Tag' : 'Deck';
    let host, member;
    if (a.type === wanted) { host = a; member = b; }
    else if (b.type === wanted) { host = b; member = a; }
    else continue;
    if (member.type === wanted) continue;

    if (!membersOf.has(host.id)) membersOf.set(host.id, []);
    membersOf.get(host.id).push(member);
  }

  for (const [hostId, members] of membersOf) {
    const taggedDocs = new Set(
      members.filter((m) => m.type === 'Document' && m.documentPath).map((m) => m.documentPath),
    );

    let mass = 0;
    let cardCount = 0;
    const seen = new Set();
    for (const m of members) {
      if (seen.has(m.id)) continue;
      if (m.type === 'Document') {
        seen.add(m.id);
      } else if (m.type === 'Flashcard') {
        if (m.flashcardDocPath && taggedDocs.has(m.flashcardDocPath)) continue;
        seen.add(m.id);
      } else {
        continue;
      }
      mass += Number(m.mass) || 0;
      cardCount += Number(m.cardCount) || 0;
    }

    out.set(hostId, { mass, cardCount });
  }

  return out;
}
