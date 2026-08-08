import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { forceCollide, forceX, forceY } from 'd3-force';
import { getGraph } from '../api/documents';
import './GraphView.css';

const HOVER_SELECT_DELAY = 700; // ms before hover auto-selects a node
const NODE_PAINT_MODE = () => 'replace';
const NODE_R = 7;

// Every knob in the controls panel is a user preference, so per the config
// convention they live in localStorage and never in config.json.
const LS = {
  tags:        'fb-graph-show-tags',
  decks:       'fb-graph-show-decks',
  links:       'fb-graph-show-links',
  origin:      'fb-graph-show-origin',
  defaultDeck: 'fb-graph-show-default-deck',
  bloom:       'fb-graph-bloom',
  cohesion:    'fb-graph-cohesion',
  collapsed:   'fb-graph-controls-collapsed',
};
const DEFAULT_COHESION = 0.6;

const clamp01 = v => Math.max(0, Math.min(1, v));

/**
 * useState that survives a reload.
 *
 * `sanitize` runs over the stored value only — a bad or hand-edited entry
 * should fall back to the default rather than wedge the view, so anything that
 * fails to parse or fails the type check is discarded.
 */
function usePersisted(key, initial, sanitize) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw);
      if (typeof parsed !== typeof initial) return initial;
      return sanitize ? sanitize(parsed) : parsed;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / private mode */ }
  }, [key, value]);
  return [value, setValue];
}

// How committed to memory a node is, 0..1. Computed server-side from FSRS
// stability where available and the Leitner level otherwise; see
// graphNodeLearning in access/orchestration/documents.js.
const learnedOf = n => n.learned || 0;

// Halo size climbs 1.5x per level up the containment hierarchy, so a folder's
// halo envelops its documents' and a document's envelops its cards'. A parent
// stands for everything under it, and its illumination should cover that ground.
const HALO_SCALE = { Flashcard: 1, Deck: 1, Tag: 1, Document: 1.5, Folder: 2.25 };
const haloScale = n => HALO_SCALE[n.type] ?? 1;

// Nodes below this barely register visually and aren't worth an arc per frame.
const LEARNED_FLOOR = 0.03;
// Above this the illumination pass costs more than it's worth.
const HALO_NODE_BUDGET = 3000;

// Relative luminance of a CSS colour string, used to pick a blend mode.
function luminance(color) {
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

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function useThemeVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setV(n => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return v;
}

function buildGraphData({ nodes = [], edges = [] }) {
  const nodeIdSet = new Set(nodes.map(n => n.id));

  const disconnected = new Set();
  for (const e of edges) {
    if (e.relation === 'disconnection') {
      disconnected.add(`${Math.min(e.fromId, e.toId)}-${Math.max(e.fromId, e.toId)}`);
    }
  }

  const inheritanceTargets = new Set();
  for (const e of edges) {
    if (e.relation === 'inheritance') inheritanceTargets.add(e.toId);
  }
  const originIds = new Set();
  for (const n of nodes) {
    if (n.type === 'Folder' && !inheritanceTargets.has(n.id)) originIds.add(n.id);
  }

  // The system "Default" deck is the automatic home for cards with no source
  // document — it links to nearly every standalone card and dominates the layout,
  // so it gets its own toggle (like Origin folders).
  const defaultDeckIds = new Set();
  for (const n of nodes) {
    if (n.type === 'Deck' && n.deckIsSystem) defaultDeckIds.add(n.id);
  }

  const links = [];
  for (const e of edges) {
    // Drop links whose endpoints aren't in the nodes array — the nodes query
    // intentionally excludes some nodes (e.g. standalone flashcards) but the
    // edges query returns all connections, leaving orphaned references that
    // crash react-force-graph-2d with "node not found".
    if (!nodeIdSet.has(e.fromId) || !nodeIdSet.has(e.toId)) continue;
    if (e.relation !== 'disconnection') {
      const key = `${Math.min(e.fromId, e.toId)}-${Math.max(e.fromId, e.toId)}`;
      if (disconnected.has(key)) continue;
    }
    links.push({ source: e.fromId, target: e.toId, relation: e.relation });
  }

  return {
    nodes: nodes.map(n => ({
      ...n,
      name: (n.type === 'Flashcard' && n.flashcardFront)
        ? n.flashcardFront.slice(0, 52) + (n.flashcardFront.length > 52 ? '…' : '')
        : (n.label ?? String(n.id)),
    })),
    links,
    originIds,
    defaultDeckIds,
  };
}

function useGraph(isActive) {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // Show loading spinner immediately in the same render that isActive flips true,
  // instead of one render later via an effect.
  const [prevIsActiveForGraph, setPrevIsActiveForGraph] = useState(isActive);
  if (prevIsActiveForGraph !== isActive) {
    setPrevIsActiveForGraph(isActive);
    if (isActive) setLoading(true);
  }

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setLoading(true);
    getGraph()
      .then(data => { if (!cancelled) { setGraphData(buildGraphData(data)); setError(null); } })
      .catch(err  => { if (!cancelled) setError(err); })
      .finally(()  => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isActive, refreshToken]);

  const refresh = useCallback(() => setRefreshToken(t => t + 1), []);
  return { graphData, loading, error, refresh };
}

function useContainerSize(ref) {
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    ro.observe(el);
    const rect = el.getBoundingClientRect();
    setSize({ width: rect.width, height: rect.height });
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function nodeId(val) {
  return typeof val === 'object' && val !== null ? val.id : val;
}

function withAlpha(color, alpha) {
  const c = color.replace(/\s/g, '');
  if (c.startsWith('#')) {
    const hex = c.slice(1).length === 3
      ? c.slice(1).split('').map(x => x + x).join('')
      : c.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const m = c.match(/rgba?\((\d+),(\d+),(\d+)/);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
  return c;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Local calendar day, not the UTC one — an export made in the evening should carry
// the date the user sees on their own clock.
function datestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function generateGraphHtml(nodes, links, colorMap, exportedAt) {
  const data = JSON.stringify({ nodes, links }).replace(/<\/script>/gi, '<\\/script>');
  const cols = JSON.stringify(colorMap);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Flashback Knowledge Graph</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1c1917; color: #d6d3d1; font-family: system-ui, sans-serif; overflow: hidden; }
#root { display: block; width: 100vw; height: 100vh; }
#panel {
  position: fixed; top: 14px; right: 14px;
  background: #292524; border: 1px solid #44403c; border-radius: 8px;
  padding: 10px 12px; font-size: 12px; color: #a8a29e;
  display: flex; flex-direction: column; gap: 5px; min-width: 130px; user-select: none;
}
.leg { display: flex; align-items: center; gap: 7px; }
.dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.sep { height: 1px; background: #44403c; margin: 2px 0; }
.tbtn {
  display: flex; align-items: center; gap: 7px;
  background: none; border: none; color: #a8a29e;
  cursor: pointer; padding: 2px; font-size: 12px; font-family: inherit;
}
.tbtn:hover { color: #e7e5e4; }
.tbtn.on { color: #e7e5e4; }
.tbtn.off span:last-child { text-decoration: line-through; opacity: 0.4; }
#meta { position: fixed; bottom: 12px; left: 14px; font-size: 11px; color: #57534e; }
#tooltip {
  position: fixed; background: #1c1917; border: 1px solid #44403c;
  border-radius: 6px; padding: 8px 10px; font-size: 12px;
  pointer-events: none; display: none; max-width: 200px; z-index: 10;
}
.tt-type { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
.tt-name { color: #e7e5e4; word-break: break-word; }
</style>
</head>
<body>
<svg id="root"></svg>
<div id="panel">
  <div id="legend"></div>
  <div class="sep"></div>
  <div id="toggles"></div>
</div>
<div id="meta">Exported ${exportedAt} &middot; ${nodes.length} nodes &middot; ${links.length} edges</div>
<div id="tooltip">
  <div class="tt-type" id="tt-type"></div>
  <div class="tt-name" id="tt-name"></div>
</div>
<script>
var GRAPH = ${data};
var COLORS = ${cols};
var hiddenTypes = {};

var svg = d3.select('#root');
var W = window.innerWidth, H = window.innerHeight;
svg.attr('width', W).attr('height', H);
var g = svg.append('g');
svg.call(d3.zoom().scaleExtent([0.05, 12]).on('zoom', function(e) { g.attr('transform', e.transform); }));

function redraw() {
  g.selectAll('*').remove();
  var nodes = GRAPH.nodes.filter(function(n) { return !hiddenTypes[n.type]; }).map(function(n) { return Object.assign({}, n); });
  var nodeIds = {};
  nodes.forEach(function(n) { nodeIds[n.id] = true; });
  var links = GRAPH.links
    .filter(function(l) { return nodeIds[l.source] && nodeIds[l.target]; })
    .map(function(l) { return Object.assign({}, l); });

  // Mirrors the in-app tuning (GraphView.jsx): short-range repulsion so
  // communities can form, collide as the no-overlap floor, and learned edges
  // that contract. Cohesion is fixed at the in-app default here.
  var learnedOf = function(n) { return n.learned || 0; };
  var minLearn = function(l) { return Math.min(learnedOf(l.source), learnedOf(l.target)); };
  var deg = {};
  links.forEach(function(l) {
    deg[l.source] = (deg[l.source] || 0) + 1;
    deg[l.target] = (deg[l.target] || 0) + 1;
  });
  var degOf = function(d) { return deg[typeof d === 'object' ? d.id : d] || 1; };

  var sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(function(d) { return d.id; })
      .distance(function(l) { return 70 - 34 * minLearn(l); })
      .strength(function(l) {
        return (1 / Math.max(1, Math.min(degOf(l.source), degOf(l.target)))) * (1 + 0.8 * minLearn(l));
      }))
    .force('charge', d3.forceManyBody().strength(-139).distanceMax(278))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide(function(d) { return 7 + 5 + learnedOf(d) * 10; }))
    .force('x', d3.forceX(W / 2).strength(function(d) { return 0.015 + 0.05 * learnedOf(d); }))
    .force('y', d3.forceY(H / 2).strength(function(d) { return 0.015 + 0.05 * learnedOf(d); }))
    .velocityDecay(0.45);

  // Same rule as the in-app graph: links rest in one neutral so they read as
  // structure rather than competing with the node colours, and the resting
  // alpha thins out as the graph gets denser. Severed links keep a dash.
  var restAlpha = Math.max(0.07, Math.min(0.30, 6 / Math.sqrt(Math.max(links.length, 1))));
  var linkSel = g.append('g').selectAll('line').data(links).join('line')
    .attr('stroke', COLORS.edge || '#777')
    .attr('stroke-dasharray', function(d) { return d.relation === 'disconnection' ? '2,3' : null; })
    .attr('stroke-opacity', restAlpha)
    .attr('stroke-width', links.length > 1200 ? 0.7 : 1.1);

  var nodeSel = g.append('g').selectAll('g').data(nodes).join('g').attr('cursor', 'pointer')
    .call(d3.drag()
      .on('start', function(e, d) { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
      .on('drag',  function(e, d) { d.fx = e.x; d.fy = e.y; })
      .on('end',   function(e, d) { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }))
    .on('mouseenter', function(e, d) {
      var tip = document.getElementById('tooltip');
      document.getElementById('tt-type').textContent = d.type;
      document.getElementById('tt-type').style.color = COLORS.nodes[d.type] || '#ccc';
      document.getElementById('tt-name').textContent = d.name;
      tip.style.display = 'block';
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top  = (e.clientY - 8)  + 'px';
    })
    .on('mousemove', function(e) {
      var tip = document.getElementById('tooltip');
      tip.style.left = (e.clientX + 14) + 'px';
      tip.style.top  = (e.clientY - 8)  + 'px';
    })
    .on('mouseleave', function() { document.getElementById('tooltip').style.display = 'none'; });

  // Learned halo, beneath the node dot. Screen blending is the SVG counterpart
  // of the in-app additive pass: adjacent learned nodes merge into one lit
  // region instead of stacking as separate discs. The export ground is always
  // dark, so screen is always the right operator here.
  var HALO_SCALE = { Flashcard: 1, Deck: 1, Tag: 1, Document: 1.5, Folder: 2.25 };
  var haloScale = function(d) { return HALO_SCALE[d.type] || 1; };
  nodeSel.append('circle')
    .attr('r', function(d) { return (7 + 4 + learnedOf(d) * 16) * haloScale(d); })
    .attr('fill', function(d) { return COLORS.nodes[d.type] || '#888'; })
    .attr('fill-opacity', function(d) {
      var L = learnedOf(d);
      return L <= 0.03 ? 0 : 0.08 + 0.20 * L;
    })
    .style('mix-blend-mode', 'screen')
    .style('pointer-events', 'none');

  nodeSel.append('circle').attr('r', 7)
    .attr('fill', function(d) { return COLORS.nodes[d.type] || '#888'; });
  nodeSel.append('text')
    .text(function(d) { return d.type === 'Flashcard' ? '' : d.name; })
    .attr('y', 18).attr('text-anchor', 'middle')
    .attr('fill', '#a8a29e').attr('font-size', 11).attr('font-family', 'system-ui, sans-serif')
    .style('pointer-events', 'none');

  sim.on('tick', function() {
    linkSel
      .attr('x1', function(d) { return d.source.x; }).attr('y1', function(d) { return d.source.y; })
      .attr('x2', function(d) { return d.target.x; }).attr('y2', function(d) { return d.target.y; });
    nodeSel.attr('transform', function(d) { return 'translate(' + d.x + ',' + d.y + ')'; });
  });
}

var legendEl = document.getElementById('legend');
Object.keys(COLORS.nodes).forEach(function(type) {
  var div = document.createElement('div');
  div.className = 'leg';
  div.innerHTML = '<span class="dot" style="background:' + COLORS.nodes[type] + '"></span><span>' + type + '</span>';
  legendEl.appendChild(div);
});

var togglesEl = document.getElementById('toggles');
['Tag', 'Deck'].forEach(function(type) {
  var btn = document.createElement('button');
  btn.className = 'tbtn on';
  btn.innerHTML = '<span class="dot" style="background:' + COLORS.nodes[type] + '"></span><span>' + type.toLowerCase() + 's</span>';
  btn.onclick = function() {
    if (hiddenTypes[type]) { delete hiddenTypes[type]; btn.className = 'tbtn on'; }
    else { hiddenTypes[type] = true; btn.className = 'tbtn off'; }
    redraw();
  };
  togglesEl.appendChild(btn);
});

window.addEventListener('resize', function() {
  W = window.innerWidth; H = window.innerHeight;
  svg.attr('width', W).attr('height', H);
});

redraw();
</script>
</body>
</html>`;
}

export default function GraphView({ isActive = false, onNavigate }) {
  const { graphData, loading, error, refresh } = useGraph(isActive);
  const [showTags, setShowTags]   = usePersisted(LS.tags, true);
  const [showDecks, setShowDecks] = usePersisted(LS.decks, true);
  const [showLinks, setShowLinks] = usePersisted(LS.links, true);
  const [showOrigin, setShowOrigin] = usePersisted(LS.origin, true);
  const [showDefaultDeck, setShowDefaultDeck] = usePersisted(LS.defaultDeck, true);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  // Bloom defaults off: the app's look is flat, and the wide soft gradient is
  // the one part of the illumination that reads as a literal glow.
  const [bloom, setBloom] = usePersisted(LS.bloom, false);
  const [cohesion, setCohesion] = usePersisted(LS.cohesion, DEFAULT_COHESION, clamp01);
  const containerRef = useRef(null);
  const fgRef = useRef(null);

  // Per-node animation state (mutated in paint loop, never triggers re-renders)
  const alphaRef = useRef({});   // focus-dim lerp
  const scaleRef = useRef({});   // hover-scale lerp
  const enterRef = useRef({});   // entrance timestamp per node id

  // Hover-to-select machinery
  const hoverTimerRef = useRef(null);
  const selectedByHoverRef = useRef(false);

  // On-demand animation loop. The custom per-node lerps (entrance fade, hover
  // scale, focus dim) need fresh frames to animate, but repainting every frame
  // forever tanks performance on large graphs. Instead we let ForceGraph pause
  // when idle (autoPauseRedraw defaults to true) and only force repaints for a
  // short window after something changes — load, hover, or selection.
  const rafRef = useRef(null);
  const animateUntilRef = useRef(0);
  // While `animating` is true we disable ForceGraph's autoPauseRedraw so the
  // canvas repaints every frame and the custom per-node lerps below can play.
  // react-force-graph-2d exposes no imperative repaint method (no `refresh()`),
  // so the redraw window is driven through this prop, not a ref call.
  const [animating, setAnimating] = useState(false);
  const nudgeAnimation = useCallback((durationMs = 900) => {
    animateUntilRef.current = Math.max(animateUntilRef.current, performance.now() + durationMs);
    setAnimating(true);
    if (rafRef.current != null) return;
    const step = () => {
      if (performance.now() < animateUntilRef.current) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
        setAnimating(false);
      }
    };
    rafRef.current = requestAnimationFrame(step);
  }, []);

  const [showExportMenu, setShowExportMenu] = useState(false);
  const [controlsCollapsed, setControlsCollapsed] = usePersisted(LS.collapsed, false);

  const { width, height } = useContainerSize(containerRef);
  const themeVer = useThemeVersion();

  // Clean up hover timer and animation loop on unmount
  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  const colors = useMemo(() => ({
    nodes: {
      Document:  getCSSVar('--color-graph-document'),
      Folder:    getCSSVar('--color-graph-folder'),
      Flashcard: getCSSVar('--color-graph-flashcard'),
      Tag:       getCSSVar('--color-graph-tag'),
      Deck:      getCSSVar('--color-graph-deck'),
    },
    links: {
      connection:    getCSSVar('--color-graph-folder'),
      disconnection: getCSSVar('--color-graph-disconnect'),
      inheritance:   getCSSVar('--color-graph-inherit'),
      tag:           getCSSVar('--color-graph-tag'),
      reference:     getCSSVar('--color-graph-flashcard'),
      deck:          getCSSVar('--color-graph-deck'),
      link:          getCSSVar('--color-graph-link'),
    },
    edge:  getCSSVar('--color-graph-edge'),
    bg:    getCSSVar('--color-bg-base'),
    label: getCSSVar('--color-fg-secondary'),
  }), [themeVer]);

  const visibleData = useMemo(() => {
    if (!graphData) return null;
    let { nodes, links, originIds, defaultDeckIds } = graphData;

    if (!showDefaultDeck && defaultDeckIds.size > 0) {
      nodes = nodes.filter(n => !defaultDeckIds.has(n.id));
      links = links.filter(l => !defaultDeckIds.has(nodeId(l.source)) && !defaultDeckIds.has(nodeId(l.target)));
    }

    if (!showTags) {
      nodes = nodes.filter(n => n.type !== 'Tag');
      links = links.filter(l => l.relation !== 'tag');
    }

    if (!showDecks) {
      nodes = nodes.filter(n => n.type !== 'Deck');
      links = links.filter(l => l.relation !== 'deck');
    }

    if (!showLinks) {
      links = links.filter(l => l.relation !== 'link');
    }

    if (!showOrigin) {
      nodes = nodes.filter(n => !originIds.has(n.id));
      links = links.filter(l => !originIds.has(nodeId(l.source)) && !originIds.has(nodeId(l.target)));
    }

    // Final guard: drop any link whose endpoint was removed by the filters above.
    // Filtering by relation type alone (e.g. removing Tag nodes but not all tag-adjacent
    // links) can leave orphaned references that crash react-force-graph-2d.
    const visibleIds = new Set(nodes.map(n => n.id));
    links = links.filter(l => visibleIds.has(nodeId(l.source)) && visibleIds.has(nodeId(l.target)));

    return { nodes, links };
  }, [graphData, showTags, showDecks, showLinks, showOrigin, showDefaultDeck]);

  // Kick the on-demand animation loop whenever visual state that drives a lerp
  // changes. Entrance fades run for 700ms; focus-dim/hover lerps settle in ~800ms.
  useEffect(() => { nudgeAnimation(900); }, [visibleData, nudgeAnimation]);
  useEffect(() => { nudgeAnimation(700); }, [hovered, selected, nudgeAnimation]);

  const focusedIds = useMemo(() => {
    if (!selected || !visibleData) return null;
    const ids = new Set([selected.id]);
    for (const l of visibleData.links) {
      const src = nodeId(l.source);
      const tgt = nodeId(l.target);
      if (src === selected.id) ids.add(tgt);
      if (tgt === selected.id) ids.add(src);
    }
    return ids;
  }, [selected, visibleData]);

  // Neighbors grouped by type for the info panel.
  // Relation-aware: for each link touching the selected node we record the
  // relation so we can pick a human label ("in deck", "tagged", etc.).
  const neighborGroups = useMemo(() => {
    if (!selected || !visibleData || !focusedIds) return [];

    // Collect neighbor ids with the most informative relation seen
    const RELATION_PRIORITY = { deck: 5, tag: 4, reference: 3, inheritance: 2, connection: 1 };
    const best = new Map(); // id → { relation, direction }

    for (const l of visibleData.links) {
      const src = nodeId(l.source);
      const tgt = nodeId(l.target);
      const isFrom = src === selected.id;
      const isTo   = tgt === selected.id;
      if (!isFrom && !isTo) continue;
      const neighborId = isFrom ? tgt : src;
      if (neighborId === selected.id) continue;
      const prio = RELATION_PRIORITY[l.relation] ?? 0;
      if (!best.has(neighborId) || prio > best.get(neighborId).prio) {
        best.set(neighborId, { relation: l.relation, direction: isFrom ? 'out' : 'in', prio });
      }
    }

    // Look up node objects
    const nodeMap = new Map(visibleData.nodes.map(n => [n.id, n]));
    const byType  = new Map();
    for (const [id, { relation, direction }] of best) {
      const n = nodeMap.get(id);
      if (!n) continue;
      const key = n.type;
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push({ ...n, relation, direction });
    }

    // Order: Folder → Document → Flashcard → Tag → Deck → rest
    const TYPE_ORDER = ['Folder', 'Document', 'Flashcard', 'Tag', 'Deck'];
    const sorted = [...byType.entries()].sort(([a], [b]) => {
      const ai = TYPE_ORDER.indexOf(a);
      const bi = TYPE_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    return sorted.map(([type, nodes]) => ({ type, nodes }));
  }, [selected, visibleData, focusedIds]);

  // Human-readable relation label between the selected node and a neighbor group.
  function relationLabel(selectedType, neighborType, relation, direction) {
    if (relation === 'deck')      return direction === 'out' ? 'in deck' : 'deck';
    if (relation === 'tag')       return direction === 'out' ? 'tagged'  : 'tag for';
    if (relation === 'reference') return direction === 'in'  ? 'flashcards' : 'source';
    if (relation === 'inheritance') {
      if (selectedType === 'Folder' && neighborType === 'Folder')    return 'subfolders';
      if (selectedType === 'Folder' && neighborType === 'Document')  return 'documents';
      if (neighborType === 'Folder')   return 'parent';
      if (neighborType === 'Document') return 'source doc';
      return direction === 'out' ? 'children' : 'parent';
    }
    if (relation === 'connection') return 'connected';
    return neighborType.toLowerCase();
  }

  // Layout: separated but clumped.
  //
  // The old tuning enforced spacing with unbounded repulsion, which meant every
  // node pushed every other node no matter how far away, and no community could
  // ever form — the graph read as an evenly-scattered field. Now repulsion is
  // short-range (distanceMax) and only handles local legibility; collide is the
  // hard no-overlap floor; links and a weak inward pull do the clumping.
  //
  // Learnedness feeds the same forces: edges between well-learned nodes are
  // shorter and stiffer, and learned nodes are pulled harder toward the centre.
  // Mastered material therefore contracts into dense knots near the core while
  // frontier material stays loose on the rim.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !visibleData) return;

    const minLearn = l => Math.min(learnedOf(l.source), learnedOf(l.target));

    fg.d3Force('charge')
      .strength(-(45 + 235 * (1 - cohesion)))
      .distanceMax(130 + 370 * (1 - cohesion));

    // Overriding link strength discards d3's default 1/min(degree) heuristic,
    // which is the only thing keeping a hub from flinging its satellites, so
    // recompute degree here and keep it as the base.
    const deg = new Map();
    for (const l of visibleData.links) {
      const s = nodeId(l.source), t = nodeId(l.target);
      deg.set(s, (deg.get(s) ?? 0) + 1);
      deg.set(t, (deg.get(t) ?? 0) + 1);
    }
    fg.d3Force('link')
      .distance(l => 70 - 34 * minLearn(l))
      .strength(l => {
        const base = 1 / Math.max(1, Math.min(deg.get(nodeId(l.source)) ?? 1, deg.get(nodeId(l.target)) ?? 1));
        return base * (1 + 0.8 * minLearn(l));
      });

    fg.d3Force('collide', forceCollide(node => NODE_R + 5 + learnedOf(node) * 10));

    // Also keeps disconnected components in frame now that repulsion is capped.
    fg.d3Force('x', forceX(0).strength(n => 0.015 + 0.05 * learnedOf(n)));
    fg.d3Force('y', forceY(0).strength(n => 0.015 + 0.05 * learnedOf(n)));

    fg.d3ReheatSimulation();
  }, [visibleData, cohesion]);

  // Text is by far the most expensive thing painted per frame, so on large
  // graphs labels only appear once the user zooms in far enough to read them.
  // Hovered/selected nodes keep their label at any zoom.
  const labelMinScale = useMemo(() => {
    const n = visibleData?.nodes.length ?? 0;
    return n > 2000 ? 2.0 : n > 800 ? 1.3 : 0.8;
  }, [visibleData]);

  const paintNode = useCallback((node, ctx, globalScale) => {
    if (!isFinite(node.x) || !isFinite(node.y)) return;
    const isSelected = selected?.id === node.id;
    const isHovered  = hovered?.id  === node.id;

    // --- Focus-dim lerp ---
    const targetAlpha = !focusedIds || focusedIds.has(node.id) ? 1 : 0.18;
    const prevAlpha = alphaRef.current[node.id] ?? 1;
    const alpha = Math.abs(targetAlpha - prevAlpha) < 0.005
      ? targetAlpha
      : lerp(prevAlpha, targetAlpha, 0.1);
    alphaRef.current[node.id] = alpha;

    // --- Hover scale lerp (suppressed when node is already selected) ---
    const targetScale = isHovered && !isSelected ? 1.35 : 1.0;
    const prevScale = scaleRef.current[node.id] ?? 1.0;
    const scale = Math.abs(targetScale - prevScale) < 0.003
      ? targetScale
      : lerp(prevScale, targetScale, 0.12);
    scaleRef.current[node.id] = scale;

    // --- Entrance fade ---
    const now = Date.now();
    if (!enterRef.current[node.id]) enterRef.current[node.id] = now;
    const entrance = Math.min(1, (now - enterRef.current[node.id]) / 700);

    const effectiveAlpha = alpha * entrance;
    const color = colors.nodes[node.type] ?? colors.nodes.Document;

    // Soft radial glow on selected node (scale-aware)
    if (isSelected) {
      const glowR = (NODE_R + 20) * scale;
      const grad = ctx.createRadialGradient(
        node.x, node.y, NODE_R * 0.4 * scale,
        node.x, node.y, glowR,
      );
      grad.addColorStop(0, withAlpha(color, 0.5 * entrance));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowR, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.globalAlpha = 1;
      ctx.fill();
    }

    // Halo glow on hovered node
    if (isHovered && !isSelected) {
      const haloR = (NODE_R + 12) * scale;
      const grad = ctx.createRadialGradient(
        node.x, node.y, NODE_R * scale,
        node.x, node.y, haloR,
      );
      grad.addColorStop(0, withAlpha(color, 0.3));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.beginPath();
      ctx.arc(node.x, node.y, haloR, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.globalAlpha = entrance;
      ctx.fill();
    }

    // The learned aureola used to be drawn here, per node. It now lives in
    // paintHalos (onRenderFramePre) so overlapping halos can blend into one
    // continuous field instead of stacking as separate discs.

    // Node circle
    const r = (isSelected ? NODE_R + 1.5 : NODE_R) * scale;
    ctx.globalAlpha = effectiveAlpha;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    // Label (flashcard labels hidden unless hovered/selected)
    const showLabel = isSelected || isHovered ||
      (node.type !== 'Flashcard' && globalScale >= labelMinScale);
    if (showLabel) {
      ctx.globalAlpha = effectiveAlpha;
      const fontSize = Math.min(14, Math.max(10, 12 / globalScale));
      ctx.font = `${fontSize}px Geist, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = colors.label;
      ctx.fillText(node.name, node.x, node.y + r + 2);
    }

    ctx.globalAlpha = 1;
  }, [colors, focusedIds, selected, hovered, labelMinScale]);

  // 'lighter' sums toward white, which is what makes overlapping halos read as
  // one brighter field — but only on a dark ground. On a light theme it washes
  // out, so overlaps darken and saturate instead. Same information either way.
  const blendMode = useMemo(
    () => (luminance(colors.bg) < 0.5 ? 'lighter' : 'multiply'),
    [colors],
  );

  // Learned illumination, painted in one pass beneath the links and nodes.
  //
  // Drawing every halo into a single blended pass is the whole point: where
  // learned nodes sit close together their halos mix into a continuous lit
  // region, so a mastered neighbourhood reads as illuminated territory rather
  // than a pile of overlapping circles.
  const paintHalos = useCallback((ctx) => {
    const nodes = visibleData?.nodes;
    if (!nodes || nodes.length > HALO_NODE_BUDGET) return;

    ctx.save();
    ctx.globalCompositeOperation = blendMode;

    // Pass 1 — flat halo colour. Hard-edged discs, not gradients: the effect is
    // additive colour, in keeping with the app's flat look.
    for (const node of nodes) {
      const L = learnedOf(node);
      if (L <= LEARNED_FLOOR || !isFinite(node.x) || !isFinite(node.y)) continue;
      const dim = alphaRef.current[node.id] ?? 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, (NODE_R + 4 + L * 16) * haloScale(node), 0, 2 * Math.PI);
      ctx.fillStyle = withAlpha(colors.nodes[node.type] ?? colors.nodes.Document,
        (0.08 + 0.20 * L) * dim);
      ctx.fill();
    }

    // Pass 2 — bloom. Opt-in, because a wide soft gradient is the one part of
    // this that reads as a literal glow. Only strongly-learned nodes bloom, so
    // an isolated mastered card stays a soft ring and a mastered cluster lights.
    if (bloom) {
      for (const node of nodes) {
        const L = learnedOf(node);
        if (L <= 0.6 || !isFinite(node.x) || !isFinite(node.y)) continue;
        const dim = alphaRef.current[node.id] ?? 1;
        const color = colors.nodes[node.type] ?? colors.nodes.Document;
        const r = (NODE_R + L * 44) * haloScale(node);
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
  }, [visibleData, colors, blendMode, bloom]);

  // Precompute the three alpha variants per relation once per theme change so
  // the per-frame link color accessor returns cached strings instead of
  // rebuilding rgba() strings for every link on every repaint.
  // A dense vault draws far more link pixels than node pixels, so relation
  // colour at rest stops being information and just blends into patches that
  // drown the nodes. Links rest in one neutral and only regain their relation
  // colour once a hover/selection isolates a subgraph small enough to trace.
  // The resting alpha falls as the graph gets denser, for the same reason.
  const restAlpha = useMemo(() => {
    const n = visibleData?.links?.length ?? 0;
    return Math.max(0.07, Math.min(0.30, 6 / Math.sqrt(Math.max(n, 1))));
  }, [visibleData]);

  const linkColors = useMemo(() => {
    const out = {};
    for (const [relation, base] of Object.entries(colors.links)) {
      out[relation] = {
        normal:  withAlpha(colors.edge, restAlpha),
        focused: withAlpha(base, 0.75),
        dim:     withAlpha(colors.edge, restAlpha * 0.3),
      };
    }
    return out;
  }, [colors, restAlpha]);

  const getLinkColor = useCallback(link => {
    const c = linkColors[link.relation] ?? linkColors.connection;
    if (!focusedIds) return c.normal;
    const focused = focusedIds.has(nodeId(link.source)) || focusedIds.has(nodeId(link.target));
    return focused ? c.focused : c.dim;
  }, [linkColors, focusedIds]);

  // A severed connection still has to be distinguishable at rest, but spending
  // colour on it would reintroduce the patches — so it gets a dash instead.
  const getLinkDash = useCallback(
    link => (link.relation === 'disconnection' ? [2, 3] : null),
    [],
  );

  // Hairlines in a dense graph, a little more presence in a sparse one.
  const linkWidth = useMemo(
    () => ((visibleData?.links?.length ?? 0) > 1200 ? 0.7 : 1.1),
    [visibleData],
  );

  const handleNodeHover = useCallback(node => {
    setHovered(node ?? null);

    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }

    if (node) {
      hoverTimerRef.current = setTimeout(() => {
        setSelected(node);
        selectedByHoverRef.current = true;
        hoverTimerRef.current = null;
      }, HOVER_SELECT_DELAY);
    } else if (selectedByHoverRef.current) {
      // Release the auto-selection when the cursor leaves
      setSelected(null);
      selectedByHoverRef.current = false;
    }
  }, []);

  const handleNodeClick = useCallback(node => {
    // Manual click overrides hover-select: cancel the timer and own the selection
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    selectedByHoverRef.current = false;
    setSelected(prev => prev?.id === node.id ? null : node);
  }, []);

  function handleExportPng() {
    const canvas = containerRef.current?.querySelector('canvas');
    if (!canvas) return;
    canvas.toBlob(blob => { if (blob) downloadBlob(blob, `flashback-graph-${datestamp()}.png`); }, 'image/png');
    setShowExportMenu(false);
  }

  function handleExportJson() {
    if (!visibleData) return;
    const out = {
      exportedAt: new Date().toISOString(),
      nodes: visibleData.nodes.map(({ id, type, name, label, presence, learned, cardCount, documentPath, flashcardHash }) =>
        ({ id, type, name, label, presence, learned, cardCount, documentPath, flashcardHash })),
      links: visibleData.links.map(l => ({ source: nodeId(l.source), target: nodeId(l.target), relation: l.relation })),
    };
    downloadBlob(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }), `flashback-graph-${datestamp()}.json`);
    setShowExportMenu(false);
  }

  function handleExportHtml() {
    if (!visibleData) return;
    const exportNodes = visibleData.nodes.map(n => ({
      id: n.id, type: n.type, name: n.name, presence: n.presence || 0, learned: learnedOf(n),
    }));
    const exportLinks = visibleData.links.map(l => ({
      source: nodeId(l.source), target: nodeId(l.target), relation: l.relation,
    }));
    const html = generateGraphHtml(exportNodes, exportLinks, colors, new Date().toLocaleString());
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `flashback-graph-${datestamp()}.html`);
    setShowExportMenu(false);
  }

  return (
    <div ref={containerRef} className="graph-root">
      {loading && <div className="graph-status">Loading graph…</div>}
      {error   && <div className="graph-status graph-status--error">Error: {error.message}</div>}
      {!loading && !error && (!visibleData || visibleData.nodes.length === 0) && (
        <div className="graph-status">
          Nothing to see here. You're empty inside. Just like me.
        </div>
      )}
      {!loading && !error && visibleData && visibleData.nodes.length > 0 && (
        <>
          <ForceGraph2D
            ref={fgRef}
            graphData={visibleData}
            width={width}
            height={height}
            backgroundColor={colors.bg}
            nodeLabel=""
            nodeRelSize={7}
            nodeCanvasObjectMode={NODE_PAINT_MODE}
            nodeCanvasObject={paintNode}
            onRenderFramePre={paintHalos}
            autoPauseRedraw={!animating}
            cooldownTime={visibleData.nodes.length > 800 ? 8000 : 15000}
            linkColor={getLinkColor}
            linkLineDash={getLinkDash}
            linkWidth={linkWidth}
            d3AlphaDecay={visibleData.nodes.length > 800 ? 0.05 : 0.0228}
            d3VelocityDecay={0.45}

            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            onBackgroundClick={() => {
              selectedByHoverRef.current = false;
              setSelected(null);
            }}
          />

          <a
            className="graph-kofi"
            href="https://ko-fi.com/D1J122ME9O"
            target="_blank"
            rel="noreferrer"
            title="Support Flashback on Ko-fi"
          >
            <svg className="graph-kofi-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 5h13a3 3 0 0 1 0 6h-1.2A5 5 0 0 1 11 15H8a4 4 0 0 1-4-4V5Z" fill="currentColor" opacity="0.28" />
              <path d="M4.5 5.5h12.5a2.5 2.5 0 0 1 0 5H15.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4.5 5.5v5.5A3.5 3.5 0 0 0 8 14.5h3a3.5 3.5 0 0 0 3.5-3.5V5.5H4.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              <path d="M8 3c0 .8-.9.9-.9 1.8M11 3c0 .8-.9.9-.9 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
              <path d="M6 18h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.5" />
            </svg>
            <span className="graph-kofi-label">Support me on Ko-fi</span>
          </a>

          <div className={`graph-controls${controlsCollapsed ? ' graph-controls--collapsed' : ''}`}>
            <button
              type="button"
              className="graph-controls-toggle"
              onClick={() => {
                setControlsCollapsed(c => !c);
                setShowExportMenu(false);
              }}
              aria-expanded={!controlsCollapsed}
              title={controlsCollapsed ? 'Expand panel' : 'Collapse panel'}
            >
              <svg className="graph-controls-glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="4" cy="4" r="2" fill="currentColor" />
                <circle cx="12" cy="6" r="2" fill="currentColor" />
                <circle cx="6" cy="12" r="2" fill="currentColor" />
                <path d="M4 4L12 6M12 6L6 12M6 12L4 4" stroke="currentColor" strokeWidth="1" opacity="0.5" />
              </svg>
              <span className="graph-controls-title">Graph</span>
              <svg className="graph-controls-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            <div className="graph-controls-body" hidden={controlsCollapsed}>
            <div className="graph-controls-section">
              <div className="graph-controls-heading">Legend</div>
              {Object.entries(colors.nodes).map(([type, color]) => (
                <div key={type} className="graph-legend-item">
                  <span className="graph-controls-dot" style={{ background: color }} />
                  <span>{type}</span>
                </div>
              ))}
            </div>

            <div className="graph-controls-section">
              <div className="graph-controls-heading">Show</div>
              {[
                { key: 'origin',  label: 'Origin folder', on: showOrigin, toggle: () => setShowOrigin(s => !s),
                  swatch: 'dot', color: colors.nodes.Folder, when: true },
                { key: 'default', label: 'Cards node', on: showDefaultDeck, toggle: () => setShowDefaultDeck(s => !s),
                  swatch: 'dot', color: colors.nodes.Deck, when: graphData?.defaultDeckIds?.size > 0 },
                { key: 'decks',   label: 'Decks', on: showDecks, toggle: () => setShowDecks(s => !s),
                  swatch: 'dot', color: colors.nodes.Deck, when: true },
                { key: 'tags',    label: 'Tags', on: showTags, toggle: () => setShowTags(s => !s),
                  swatch: 'line', color: colors.links.tag, when: true },
                { key: 'links',   label: 'Links', on: showLinks, toggle: () => setShowLinks(s => !s),
                  swatch: 'line', color: colors.links.link, when: true },
              ].filter(f => f.when).map(f => (
                <button key={f.key} type="button" role="switch" aria-checked={f.on}
                  className={`graph-filter${f.on ? ' graph-filter--on' : ''}`}
                  onClick={f.toggle}
                  title={`${f.on ? 'Hide' : 'Show'} ${f.label.toLowerCase()}`}
                >
                  <span className={f.swatch === 'line' ? 'graph-controls-line' : 'graph-controls-dot'}
                    style={{ background: f.color, opacity: f.on ? 1 : 0.3 }} />
                  <span className="graph-filter-label">{f.label}</span>
                  <span className="graph-switch" aria-hidden="true" />
                </button>
              ))}
            </div>

            <div className="graph-controls-section">
              <div className="graph-controls-heading">Illumination</div>
              <button type="button" role="switch" aria-checked={bloom}
                className={`graph-filter${bloom ? ' graph-filter--on' : ''}`}
                onClick={() => setBloom(b => !b)}
                title={`${bloom ? 'Hide' : 'Show'} bloom around well-learned nodes`}
              >
                <span className="graph-controls-dot"
                  style={{ background: colors.nodes.Flashcard, opacity: bloom ? 1 : 0.3 }} />
                <span className="graph-filter-label">Bloom</span>
                <span className="graph-switch" aria-hidden="true" />
              </button>

              <label className="graph-slider-row">
                <span className="graph-slider-label">Cohesion</span>
                <input type="range" className="graph-slider"
                  min="0" max="1" step="0.05"
                  value={cohesion}
                  onChange={e => setCohesion(parseFloat(e.target.value))}
                  title="How tightly related nodes clump together"
                />
              </label>
            </div>

            <div className="graph-controls-actions">
              <button type="button"
                className="graph-action-btn"
                onClick={refresh}
                title="Refresh graph data"
                disabled={loading}
              >
                Refresh
              </button>

              <button type="button"
                className={`graph-action-btn${showExportMenu ? ' graph-action-btn--active' : ''}`}
                onClick={() => setShowExportMenu(s => !s)}
                title="Export graph"
              >
                Export
              </button>
            </div>

            {showExportMenu && (
              <div className="graph-export-menu">
                <button type="button" className="graph-export-item" onClick={handleExportPng}>PNG image</button>
                <button type="button" className="graph-export-item" onClick={handleExportJson}>JSON data</button>
                <button type="button" className="graph-export-item" onClick={handleExportHtml}>Interactive HTML</button>
              </div>
            )}
            </div>
          </div>

          {selected && (
            <div className="graph-info">
              <div className="graph-info-type" style={{ color: colors.nodes[selected.type] }}>
                {selected.type}
              </div>
              <div className="graph-info-name">{selected.name}</div>
              <button type="button" className="graph-info-close" onClick={() => {
                selectedByHoverRef.current = false;
                setSelected(null);
              }}>×</button>

              {neighborGroups.length > 0 && (
                <div className="graph-info-neighbors">
                  {neighborGroups.map(({ type, nodes }) => {
                    const LIMIT = 5;
                    const shown   = nodes.slice(0, LIMIT);
                    const overflow = nodes.length - LIMIT;
                    const label = relationLabel(
                      selected.type, type,
                      nodes[0].relation, nodes[0].direction,
                    );
                    return (
                      <div key={type} className="graph-info-group">
                        <div className="graph-info-group-header">
                          <span className="graph-info-group-dot"
                            style={{ background: colors.nodes[type] }} />
                          <span className="graph-info-group-label">{label}</span>
                          <span className="graph-info-group-count">{nodes.length}</span>
                        </div>
                        <div className="graph-info-group-items">
                          {shown.map(n => {
                            const displayName = n.type === 'Flashcard' && n.flashcardFront
                              ? n.flashcardFront.slice(0, 52) + (n.flashcardFront.length > 52 ? '…' : '')
                              : n.name;
                            const canNavigate = onNavigate && (
                              (n.type === 'Flashcard' && !!n.flashcardDocPath) ||
                              (n.type === 'Document'  && !!n.documentPath)
                            );
                            const handleChipClick = canNavigate ? () => {
                              if (n.type === 'Flashcard') {
                                onNavigate({ type: 'flashcard', payload: { documentPath: n.flashcardDocPath } });
                              } else if (n.type === 'Document') {
                                onNavigate({ type: 'document', payload: { path: n.documentPath } });
                              }
                            } : undefined;
                            const chipTitle = n.type === 'Flashcard' && n.flashcardFront ? n.flashcardFront : n.name;
                            return canNavigate ? (
                              <button
                                type="button"
                                key={n.id}
                                className="graph-info-neighbor graph-info-neighbor--link"
                                title={chipTitle}
                                onClick={handleChipClick}
                              >
                                {displayName}
                              </button>
                            ) : (
                              <span key={n.id} className="graph-info-neighbor" title={chipTitle}>
                                {displayName}
                              </span>
                            );
                          })}
                          {overflow > 0 && (
                            <span className="graph-info-overflow">+{overflow} more</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
