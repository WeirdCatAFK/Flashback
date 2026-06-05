import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { forceCollide } from 'd3-force';
import { getGraph } from '../api/documents';
import './GraphView.css';

const DIRECTED = new Set(['inheritance', 'reference']);

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
  // Disconnection overrides
  const disconnected = new Set();
  for (const e of edges) {
    if (e.relation === 'disconnection') {
      disconnected.add(`${Math.min(e.fromId, e.toId)}-${Math.max(e.fromId, e.toId)}`);
    }
  }

  // Origin nodes: Folder nodes that are never the *target* of an inheritance edge
  // (i.e. they have no parent in the hierarchy — they are workspace roots)
  const inheritanceTargets = new Set(
    edges.filter(e => e.relation === 'inheritance').map(e => e.toId)
  );
  const originIds = new Set(
    nodes.filter(n => n.type === 'Folder' && !inheritanceTargets.has(n.id)).map(n => n.id)
  );

  return {
    nodes: nodes.map(n => ({ ...n, name: n.label ?? String(n.id) })),
    links: edges
      .filter(e => {
        if (e.relation === 'disconnection') return true;
        const key = `${Math.min(e.fromId, e.toId)}-${Math.max(e.fromId, e.toId)}`;
        return !disconnected.has(key);
      })
      .map(e => ({ source: e.fromId, target: e.toId, relation: e.relation })),
    originIds,
  };
}

function useGraph(isActive) {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    setLoading(true);
    getGraph()
      .then(data => { if (!cancelled) { setGraphData(buildGraphData(data)); setError(null); } })
      .catch(err  => { if (!cancelled) setError(err); })
      .finally(()  => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isActive]);

  return { graphData, loading, error };
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

// force-graph mutates link.source/target from IDs → node objects after first render
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

export default function GraphView({ isActive = false }) {
  const { graphData, loading, error } = useGraph(isActive);
  const [showTags, setShowTags] = useState(true);
  const [showOrigin, setShowOrigin] = useState(true);
  const [selected, setSelected] = useState(null);
  const containerRef = useRef(null);
  const fgRef = useRef(null);
  const alphaRef = useRef({});
  const { width, height } = useContainerSize(containerRef);
  const themeVer = useThemeVersion();

  const colors = useMemo(() => ({
    nodes: {
      Document:  getCSSVar('--color-graph-document'),
      Folder:    getCSSVar('--color-graph-folder'),
      Flashcard: getCSSVar('--color-graph-flashcard'),
      Tag:       getCSSVar('--color-graph-tag'),
    },
    links: {
      connection:    getCSSVar('--color-graph-folder'),
      disconnection: getCSSVar('--color-graph-disconnect'),
      inheritance:   getCSSVar('--color-graph-inherit'),
      tag:           getCSSVar('--color-graph-tag'),
      reference:     getCSSVar('--color-graph-flashcard'),
    },
    bg:    getCSSVar('--color-bg-base'),
    label: getCSSVar('--color-fg-secondary'),
  }), [themeVer]);

  const visibleData = useMemo(() => {
    if (!graphData) return null;
    let { nodes, links, originIds } = graphData;

    if (!showTags) {
      nodes = nodes.filter(n => n.type !== 'Tag');
      links = links.filter(l => l.relation !== 'tag');
    }

    if (!showOrigin) {
      nodes = nodes.filter(n => !originIds.has(n.id));
      links = links.filter(l => !originIds.has(nodeId(l.source)) && !originIds.has(nodeId(l.target)));
    }

    return { nodes, links };
  }, [graphData, showTags, showOrigin]);

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

  // Tune forces whenever visible data changes (initial load + toggle events)
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !visibleData) return;

    fg.d3Force('charge').strength(-90);
    fg.d3Force('link').distance(60);
    fg.d3Force('collide', forceCollide(node => {
      const presenceNorm = Math.min(1, (node.presence || 0) / 10);
      // collision radius = node circle + full aureola + label clearance below
      return NODE_R + presenceNorm * 12;
    }));
  }, [visibleData]);

  const NODE_R = 5; // must match nodeRelSize for correct hit detection

  const paintNode = useCallback((node, ctx, globalScale) => {
    const isSelected = selected?.id === node.id;
    const targetAlpha = !focusedIds || focusedIds.has(node.id) ? 1 : 0.18;
    const prev = alphaRef.current[node.id] ?? 1;
    const alpha = Math.abs(targetAlpha - prev) < 0.005
      ? targetAlpha
      : prev + (targetAlpha - prev) * 0.1;
    alphaRef.current[node.id] = alpha;

    const color = colors.nodes[node.type] ?? colors.nodes.Document;
    const presenceNorm = Math.min(1, (node.presence || 0) / 10);

    // Soft radial glow on selected node
    if (isSelected) {
      const glowR = NODE_R + 18;
      const grad = ctx.createRadialGradient(node.x, node.y, NODE_R * 0.4, node.x, node.y, glowR);
      grad.addColorStop(0, withAlpha(color, 0.5));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowR, 0, 2 * Math.PI);
      ctx.fillStyle = grad;
      ctx.globalAlpha = 1;
      ctx.fill();
    }

    // Aureola — translucent halo that grows with presence
    if (presenceNorm > 0.02) {
      const aureolaR = NODE_R + presenceNorm * 12;
      ctx.beginPath();
      ctx.arc(node.x, node.y, aureolaR, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha * 0.3 * presenceNorm;
      ctx.fill();
    }

    // Node circle (selected node drawn slightly larger)
    const r = isSelected ? NODE_R + 1.5 : NODE_R;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    // Label (only when zoomed in enough)
    if (globalScale >= 0.8) {
      ctx.globalAlpha = alpha;
      const fontSize = Math.min(14, Math.max(10, 12 / globalScale));
      ctx.font = `${fontSize}px Geist, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = colors.label;
      ctx.fillText(node.name, node.x, node.y + r + 2);
    }

    ctx.globalAlpha = 1;
  }, [colors, focusedIds, selected]);

  const getLinkColor = useCallback(link => {
    const base = colors.links[link.relation] ?? colors.links.connection;
    if (!focusedIds) return base;
    const focused = focusedIds.has(nodeId(link.source)) || focusedIds.has(nodeId(link.target));
    return focused ? base : withAlpha(base, 0.15);
  }, [colors, focusedIds]);

  return (
    <div ref={containerRef} className="graph-root">
      {loading && <div className="graph-status">Loading graph…</div>}
      {error   && <div className="graph-status graph-status--error">Error: {error.message}</div>}
      {!loading && !error && visibleData && (
        <>
          <ForceGraph2D
            ref={fgRef}
            graphData={visibleData}
            width={width}
            height={height}
            backgroundColor={colors.bg}
            nodeLabel="name"
            nodeColor={node => colors.nodes[node.type] ?? colors.nodes.Document}
            nodeRelSize={5}
            nodeCanvasObjectMode={() => 'replace'}
            nodeCanvasObject={paintNode}
            linkColor={getLinkColor}
            linkDirectionalArrowColor={getLinkColor}
            linkWidth={1.5}
            linkHoverPrecision={8}
            linkDirectionalArrowLength={link => DIRECTED.has(link.relation) ? 5 : 0}
            linkDirectionalArrowRelPos={1}
            linkLabel={link => link.relation}
            onNodeClick={node => setSelected(prev => prev?.id === node.id ? null : node)}
            onBackgroundClick={() => setSelected(null)}
          />

          <div className="graph-controls">
            {Object.entries(colors.nodes).map(([type, color]) => (
              <div key={type} className="graph-controls-item">
                <span className="graph-controls-dot" style={{ background: color }} />
                <span>{type}</span>
              </div>
            ))}

            <div className="graph-controls-sep" />

            <button
              className={`graph-toggle-btn${showOrigin ? ' graph-toggle-btn--active' : ''}`}
              onClick={() => setShowOrigin(s => !s)}
              title={showOrigin ? 'Hide workspace origin nodes' : 'Show workspace origin nodes'}
            >
              <span className="graph-controls-dot" style={{
                background: colors.nodes.Folder,
                opacity: showOrigin ? 1 : 0.25,
              }} />
              <span>origin</span>
            </button>

            <button
              className={`graph-toggle-btn${showTags ? ' graph-toggle-btn--active' : ''}`}
              onClick={() => setShowTags(s => !s)}
              title={showTags ? 'Hide tag connections' : 'Show tag connections'}
            >
              <span className="graph-controls-line" style={{
                background: colors.links.tag,
                opacity: showTags ? 1 : 0.25,
              }} />
              <span>tags</span>
            </button>
          </div>

          {selected && (
            <div className="graph-info">
              <div className="graph-info-type" style={{ color: colors.nodes[selected.type] }}>
                {selected.type}
              </div>
              <div className="graph-info-name">{selected.name}</div>
              <button className="graph-info-close" onClick={() => setSelected(null)}>×</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
