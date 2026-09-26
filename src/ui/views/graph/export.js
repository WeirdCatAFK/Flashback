/**
 * Graph exports: PNG from the canvas, JSON of the visible graph, and a standalone
 * interactive HTML page. The page runs outside the app, so it carries its own
 * already-translated strings and restates the halo maths with the constants
 * interpolated from graphMetrics — the numbers cannot drift even though the
 * function bodies are duplicated.
 */

import { HALO_BASE, HALO_K, HALO_MAX } from '../graphMetrics.js';
import { learnedOf, massOf, nodeId } from './graphData.js';

/** The local calendar day — an evening export carries the date the user sees. */
export function datestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** The visible graph as a plain, id-keyed JSON document. */
export function exportJson(visibleData, exportedAt = new Date().toISOString()) {
  return {
    exportedAt,
    nodes: visibleData.nodes.map(({ id, type, name, label, presence, learned, mass, cardCount, documentPath, flashcardHash }) =>
      ({ id, type, name, label, presence, learned, mass, cardCount, documentPath, flashcardHash })),
    links: visibleData.links.map((l) => ({ source: nodeId(l.source), target: nodeId(l.target), relation: l.relation })),
  };
}

/** The nodes and links the standalone page needs, and nothing else. */
export function exportShape(visibleData) {
  return {
    nodes: visibleData.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name, presence: n.presence || 0, learned: learnedOf(n), mass: massOf(n) })),
    links: visibleData.links.map((l) => ({ source: nodeId(l.source), target: nodeId(l.target), relation: l.relation })),
  };
}

/**
 * The standalone page. `text` holds the already-translated strings; nothing in
 * here may call t() itself, since the page runs outside the provider.
 */
export function generateGraphHtml(nodes, links, colorMap, text) {
  const data = JSON.stringify({ nodes, links }).replace(/<\/script>/gi, '<\\/script>');
  const cols = JSON.stringify(colorMap);
  const typeLabels = JSON.stringify(text.typeLabels).replace(/<\/script>/gi, '<\\/script>');
  const toggleLabels = JSON.stringify(text.toggleLabels).replace(/<\/script>/gi, '<\\/script>');
  return `<!DOCTYPE html>
<html lang="${escapeHtml(text.lang)}">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(text.title)}</title>
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
<div id="meta">${escapeHtml(text.meta)}</div>
<div id="tooltip">
  <div class="tt-type" id="tt-type"></div>
  <div class="tt-name" id="tt-name"></div>
</div>
<script>
var GRAPH = ${data};
var COLORS = ${cols};
var TYPE_LABELS = ${typeLabels};
var TOGGLE_LABELS = ${toggleLabels};
var labelOf = function(type) { return TYPE_LABELS[type] || type; };
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
  //
  // This page is standalone and cannot import graphMetrics.js, so the halo math
  // is restated below. The constants are interpolated from the module, so the
  // numbers cannot drift even though the function bodies are duplicated.
  var learnedOf = function(n) { return n.learned || 0; };
  var massOf    = function(n) { return n.mass || 0; };
  var haloRadius = function(m) {
    if (!(m > 0)) return ${HALO_BASE};
    return Math.min(${HALO_MAX}, ${HALO_BASE} + ${HALO_K} * Math.sqrt(m));
  };
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
    .force('collide', d3.forceCollide(function(d) { return 7 + 5 + 0.35 * (haloRadius(massOf(d)) - ${HALO_BASE}); }))
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
      document.getElementById('tt-type').textContent = labelOf(d.type);
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
  //
  // Size from mass, opacity from the learned rate — the same two channels the
  // in-app graph uses, so a big half-known area out-glows a small perfect one.
  nodeSel.append('circle')
    .attr('r', function(d) { return haloRadius(massOf(d)); })
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

// Labels go in through textContent, not innerHTML — a translation is ordinary
// text and must not be parsed as markup.
function swatch(parent, cls, color, label) {
  var dot = document.createElement('span');
  dot.className = cls;
  dot.style.background = color;
  var span = document.createElement('span');
  span.textContent = label;
  parent.appendChild(dot);
  parent.appendChild(span);
}

var legendEl = document.getElementById('legend');
Object.keys(COLORS.nodes).forEach(function(type) {
  var div = document.createElement('div');
  div.className = 'leg';
  swatch(div, 'dot', COLORS.nodes[type], labelOf(type));
  legendEl.appendChild(div);
});

var togglesEl = document.getElementById('toggles');
['Tag', 'Deck'].forEach(function(type) {
  var btn = document.createElement('button');
  btn.className = 'tbtn on';
  swatch(btn, 'dot', COLORS.nodes[type], TOGGLE_LABELS[type] || type);
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
