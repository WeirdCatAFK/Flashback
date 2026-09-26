/**
 * The graph as data: the API payload turned into nodes and links, the visibility
 * filters, and the neighbourhood of a selected node. Pure, so the ordering and
 * aggregation rules are testable without a canvas.
 */

import { aggregateMass } from '../graphMetrics.js';

const NAME_MAX = 52;

/** A link endpoint's id, whether d3 has already replaced it with the node object. */
export const nodeId = (val) => (typeof val === 'object' && val !== null ? val.id : val);

/** How committed to memory a node is, 0..1 — a rate; drives halo opacity. */
export const learnedOf = (n) => n.learned || 0;

/** How much knowledge a node stands for, in mastered-card-equivalents; drives halo size. */
export const massOf = (n) => n.mass || 0;

/** A flashcard shows its front, truncated; everything else its label. */
export function nodeDisplayName(n) {
  return (n.type === 'Flashcard' && n.flashcardFront)
    ? n.flashcardFront.slice(0, NAME_MAX) + (n.flashcardFront.length > NAME_MAX ? '…' : '')
    : (n.label ?? n.name ?? String(n.id));
}

/**
 * Nodes and links from the API payload. Links to a node that is not in the
 * payload are dropped (react-force-graph crashes on them), disconnections cancel
 * the edge they sever, and mass is aggregated over the surviving links.
 */
export function buildGraphData({ nodes = [], edges = [] }) {
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const pairKey = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

  const disconnected = new Set();
  const inheritanceTargets = new Set();
  for (const e of edges) {
    if (e.relation === 'disconnection') disconnected.add(pairKey(e.fromId, e.toId));
    if (e.relation === 'inheritance') inheritanceTargets.add(e.toId);
  }

  const originIds = new Set();
  const defaultDeckIds = new Set();
  for (const n of nodes) {
    if (n.type === 'Folder' && !inheritanceTargets.has(n.id)) originIds.add(n.id);
    if (n.type === 'Deck' && n.deckIsSystem) defaultDeckIds.add(n.id);
  }

  const links = [];
  for (const e of edges) {
    if (!nodeIdSet.has(e.fromId) || !nodeIdSet.has(e.toId)) continue;
    if (e.relation !== 'disconnection' && disconnected.has(pairKey(e.fromId, e.toId))) continue;
    links.push({ source: e.fromId, target: e.toId, relation: e.relation });
  }

  const named = nodes.map((n) => ({ ...n, name: nodeDisplayName(n) }));
  const aggregated = aggregateMass(named, links);
  for (const n of named) {
    const agg = aggregated.get(n.id);
    if (!agg) continue;
    n.mass = agg.mass;
    n.cardCount = agg.cardCount;
    n.learned = agg.cardCount > 0 ? Math.min(1, agg.mass / agg.cardCount) : 0;
  }

  return { nodes: named, links, originIds, defaultDeckIds };
}

/** The subset of the graph the panel's toggles leave visible. */
export function applyVisibility(graphData, { showTags, showDecks, showLinks, showOrigin, showDefaultDeck }) {
  let { nodes, links } = graphData;
  const { originIds, defaultDeckIds } = graphData;
  const dropNodes = (pred) => {
    nodes = nodes.filter((n) => !pred(n));
  };

  if (!showDefaultDeck && defaultDeckIds.size > 0) dropNodes((n) => defaultDeckIds.has(n.id));
  if (!showTags) { dropNodes((n) => n.type === 'Tag'); links = links.filter((l) => l.relation !== 'tag'); }
  if (!showDecks) { dropNodes((n) => n.type === 'Deck'); links = links.filter((l) => l.relation !== 'deck'); }
  if (!showLinks) links = links.filter((l) => l.relation !== 'link');
  if (!showOrigin) dropNodes((n) => originIds.has(n.id));

  const visibleIds = new Set(nodes.map((n) => n.id));
  links = links.filter((l) => visibleIds.has(nodeId(l.source)) && visibleIds.has(nodeId(l.target)));
  return { nodes, links };
}

/** The selected node and everything one link away. */
export function focusedIdsFor(selected, visibleData) {
  if (!selected || !visibleData) return null;
  const ids = new Set([selected.id]);
  for (const l of visibleData.links) {
    const src = nodeId(l.source);
    const tgt = nodeId(l.target);
    if (src === selected.id) ids.add(tgt);
    if (tgt === selected.id) ids.add(src);
  }
  return ids;
}

const RELATION_PRIORITY = { deck: 5, tag: 4, reference: 3, inheritance: 2, connection: 1 };
const TYPE_ORDER = ['Folder', 'Document', 'Flashcard', 'Tag', 'Deck'];

/**
 * The selected node's neighbours grouped by type, each carrying the strongest
 * relation that reaches it and the direction it was reached in.
 * @returns {{ type: string, nodes: object[] }[]}
 */
export function neighborGroupsFor(selected, visibleData) {
  if (!selected || !visibleData) return [];
  const best = new Map();
  for (const l of visibleData.links) {
    const src = nodeId(l.source);
    const tgt = nodeId(l.target);
    const isFrom = src === selected.id;
    const isTo = tgt === selected.id;
    if (!isFrom && !isTo) continue;
    const neighborId = isFrom ? tgt : src;
    if (neighborId === selected.id) continue;
    const prio = RELATION_PRIORITY[l.relation] ?? 0;
    if (!best.has(neighborId) || prio > best.get(neighborId).prio) {
      best.set(neighborId, { relation: l.relation, direction: isFrom ? 'out' : 'in', prio });
    }
  }

  const nodeMap = new Map(visibleData.nodes.map((n) => [n.id, n]));
  const byType = new Map();
  for (const [id, { relation, direction }] of best) {
    const n = nodeMap.get(id);
    if (!n) continue;
    if (!byType.has(n.type)) byType.set(n.type, []);
    byType.get(n.type).push({ ...n, relation, direction });
  }

  const rank = (type) => { const i = TYPE_ORDER.indexOf(type); return i === -1 ? 99 : i; };
  return [...byType.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([type, nodes]) => ({ type, nodes }));
}
