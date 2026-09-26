/**
 * Canvas painters for the force graph: the node dot with its selection and
 * hover glows, the learned halos painted in one pass beneath everything, and the
 * link colour cache. Per-node animation state (alpha, scale, entrance time)
 * lives in the `anim` object the caller owns, never in module scope.
 */

import { haloRadius } from '../graphMetrics.js';
import { learnedOf, massOf, nodeId } from './graphData.js';

export const NODE_R = 7;
/** Nodes below this barely register visually and are not worth an arc per frame. */
export const LEARNED_FLOOR = 0.03;
/** Above this the illumination pass costs more than it is worth. */
export const HALO_NODE_BUDGET = 3000;
const ENTRANCE_MS = 700;

export const lerp = (a, b, t) => a + (b - a) * t;

/** Relative luminance of a CSS colour string, used to pick a blend mode. */
export function luminance(color) {
  let r, g, b;
  const hex = color?.trim().replace('#', '');
  if (hex?.length === 6) {
    r = parseInt(hex.slice(0, 2), 16); g = parseInt(hex.slice(2, 4), 16); b = parseInt(hex.slice(4, 6), 16);
  } else if (hex?.length === 3) {
    r = parseInt(hex[0] + hex[0], 16); g = parseInt(hex[1] + hex[1], 16); b = parseInt(hex[2] + hex[2], 16);
  } else {
    const m = color?.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!m) return 0;
    r = +m[1]; g = +m[2]; b = +m[3];
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** `color` (hex or rgb[a]) with its alpha replaced. */
export function withAlpha(color, alpha) {
  const c = color.replace(/\s/g, '');
  if (c.startsWith('#')) {
    const hex = c.slice(1).length === 3 ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1);
    return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${alpha})`;
  }
  const m = c.match(/rgba?\((\d+),(\d+),(\d+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
  return c;
}

/** Additive light on a dark ground, multiply on a light one. */
export const blendModeFor = (bg) => (luminance(bg) < 0.5 ? 'lighter' : 'multiply');

/** Labels only appear zoomed in on a big graph — text is the most expensive paint. */
export const labelMinScaleFor = (nodeCount) => (nodeCount > 2000 ? 2.0 : nodeCount > 800 ? 1.3 : 0.8);

/** Links rest in one neutral that thins out as the graph gets denser. */
export const restAlphaFor = (linkCount) => Math.max(0.07, Math.min(0.30, 6 / Math.sqrt(Math.max(linkCount, 1))));

export const linkWidthFor = (linkCount) => (linkCount > 1200 ? 0.7 : 1.1);

/** The three colours each relation can take: resting, focused, dimmed. */
export function linkColorsFor(colors, restAlpha) {
  const out = {};
  for (const [relation, base] of Object.entries(colors.links)) {
    out[relation] = {
      normal: withAlpha(colors.edge, restAlpha),
      focused: withAlpha(base, 0.75),
      dim: withAlpha(colors.edge, restAlpha * 0.3),
    };
  }
  return out;
}

export function linkColor(link, linkColors, focusedIds) {
  const c = linkColors[link.relation] ?? linkColors.connection;
  if (!focusedIds) return c.normal;
  const focused = focusedIds.has(nodeId(link.source)) || focusedIds.has(nodeId(link.target));
  return focused ? c.focused : c.dim;
}

export const linkDash = (link) => (link.relation === 'disconnection' ? [2, 3] : null);

/** A fresh per-node animation store. */
export const newAnimState = () => ({ alpha: {}, scale: {}, enter: {} });

/**
 * One node: eased dimming, hover scale, entrance fade, selection glow, dot and label.
 * @param {{ colors, focusedIds, selectedId, hoveredId, labelMinScale, anim }} state
 */
export function paintNode(node, ctx, globalScale, state) {
  if (!isFinite(node.x) || !isFinite(node.y)) return;
  const { colors, focusedIds, selectedId, hoveredId, labelMinScale, anim } = state;
  const isSelected = selectedId === node.id;
  const isHovered = hoveredId === node.id;

  const targetAlpha = !focusedIds || focusedIds.has(node.id) ? 1 : 0.18;
  const prevAlpha = anim.alpha[node.id] ?? 1;
  const alpha = Math.abs(targetAlpha - prevAlpha) < 0.005 ? targetAlpha : lerp(prevAlpha, targetAlpha, 0.1);
  anim.alpha[node.id] = alpha;

  const targetScale = isHovered && !isSelected ? 1.35 : 1.0;
  const prevScale = anim.scale[node.id] ?? 1.0;
  const scale = Math.abs(targetScale - prevScale) < 0.003 ? targetScale : lerp(prevScale, targetScale, 0.12);
  anim.scale[node.id] = scale;

  const now = Date.now();
  if (!anim.enter[node.id]) anim.enter[node.id] = now;
  const entrance = Math.min(1, (now - anim.enter[node.id]) / ENTRANCE_MS);
  const effectiveAlpha = alpha * entrance;
  const color = colors.nodes[node.type] ?? colors.nodes.Document;

  if (isSelected) {
    const glowR = (NODE_R + 20) * scale;
    const grad = ctx.createRadialGradient(node.x, node.y, NODE_R * 0.4 * scale, node.x, node.y, glowR);
    grad.addColorStop(0, withAlpha(color, 0.5 * entrance));
    grad.addColorStop(1, withAlpha(color, 0));
    ctx.beginPath();
    ctx.arc(node.x, node.y, glowR, 0, 2 * Math.PI);
    ctx.fillStyle = grad;
    ctx.globalAlpha = 1;
    ctx.fill();
  }

  if (isHovered && !isSelected) {
    const haloR = (NODE_R + 12) * scale;
    const grad = ctx.createRadialGradient(node.x, node.y, NODE_R * scale, node.x, node.y, haloR);
    grad.addColorStop(0, withAlpha(color, 0.3));
    grad.addColorStop(1, withAlpha(color, 0));
    ctx.beginPath();
    ctx.arc(node.x, node.y, haloR, 0, 2 * Math.PI);
    ctx.fillStyle = grad;
    ctx.globalAlpha = entrance;
    ctx.fill();
  }

  const r = (isSelected ? NODE_R + 1.5 : NODE_R) * scale;
  ctx.globalAlpha = effectiveAlpha;
  ctx.beginPath();
  ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();

  const showLabel = isSelected || isHovered || (node.type !== 'Flashcard' && globalScale >= labelMinScale);
  if (showLabel) {
    ctx.globalAlpha = effectiveAlpha;
    const fontSize = Math.min(14, Math.max(10, 12 / globalScale));
    ctx.font = `${fontSize}px 'Didact Gothic', 'Noto Sans', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colors.label;
    ctx.fillText(node.name, node.x, node.y + r + 2);
  }
  ctx.globalAlpha = 1;
}

/**
 * The learned halos, painted in one blended pass so adjacent learned nodes read
 * as one lit region. Size comes from mass, opacity from the learned rate; bloom
 * adds a wider soft glow around well-learned nodes.
 * @param {{ nodes, colors, blendMode, bloom, anim }} state
 */
export function paintHalos(ctx, { nodes, colors, blendMode, bloom, anim }) {
  if (!nodes || nodes.length > HALO_NODE_BUDGET) return;
  ctx.save();
  ctx.globalCompositeOperation = blendMode;

  for (const node of nodes) {
    const L = learnedOf(node);
    if (L <= LEARNED_FLOOR || !isFinite(node.x) || !isFinite(node.y)) continue;
    const dim = anim.alpha[node.id] ?? 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, haloRadius(massOf(node)), 0, 2 * Math.PI);
    ctx.fillStyle = withAlpha(colors.nodes[node.type] ?? colors.nodes.Document, (0.08 + 0.20 * L) * dim);
    ctx.fill();
  }

  if (bloom) {
    for (const node of nodes) {
      const L = learnedOf(node);
      if (L <= 0.6 || !isFinite(node.x) || !isFinite(node.y)) continue;
      const dim = anim.alpha[node.id] ?? 1;
      const color = colors.nodes[node.type] ?? colors.nodes.Document;
      const r = haloRadius(massOf(node)) * 1.8;
      const grad = ctx.createRadialGradient(node.x, node.y, NODE_R, node.x, node.y, r);
      grad.addColorStop(0, withAlpha(color, 0.07 * ((L - 0.6) / 0.4) * dim));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }
  ctx.restore();
}
