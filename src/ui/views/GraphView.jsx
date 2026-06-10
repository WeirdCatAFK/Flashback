import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { forceCollide } from 'd3-force';
import { getGraph } from '../api/documents';
import './GraphView.css';

const DIRECTED = new Set(['inheritance', 'reference']);
const HOVER_SELECT_DELAY = 700; // ms before hover auto-selects a node

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

  const links = [];
  for (const e of edges) {
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
  };
}

function useGraph(isActive) {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

export default function GraphView({ isActive = false, onNavigate }) {
  const { graphData, loading, error } = useGraph(isActive);
  const [showTags, setShowTags]   = useState(true);
  const [showDecks, setShowDecks] = useState(true);
  const [showOrigin, setShowOrigin] = useState(true);
  const [selected, setSelected] = useState(null);
  const [hovered, setHovered] = useState(null);
  const containerRef = useRef(null);
  const fgRef = useRef(null);

  // Per-node animation state (mutated in paint loop, never triggers re-renders)
  const alphaRef = useRef({});   // focus-dim lerp
  const scaleRef = useRef({});   // hover-scale lerp
  const enterRef = useRef({});   // entrance timestamp per node id

  // Hover-to-select machinery
  const hoverTimerRef = useRef(null);
  const selectedByHoverRef = useRef(false);

  const { width, height } = useContainerSize(containerRef);
  const themeVer = useThemeVersion();

  // Clean up hover timer on unmount
  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
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

    if (!showDecks) {
      nodes = nodes.filter(n => n.type !== 'Deck');
      links = links.filter(l => l.relation !== 'deck');
    }

    if (!showOrigin) {
      nodes = nodes.filter(n => !originIds.has(n.id));
      links = links.filter(l => !originIds.has(nodeId(l.source)) && !originIds.has(nodeId(l.target)));
    }

    return { nodes, links };
  }, [graphData, showTags, showDecks, showOrigin]);

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

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !visibleData) return;

    fg.d3Force('charge').strength(-90);
    fg.d3Force('link').distance(60);
    fg.d3Force('collide', forceCollide(node => {
      const presenceNorm = Math.min(1, (node.presence || 0) / 10);
      return NODE_R + presenceNorm * 12;
    }));
  }, [visibleData]);

  const NODE_R = 7;

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
    const presenceNorm = Math.min(1, (node.presence || 0) / 10);

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

    // Aureola — translucent halo that grows with presence
    if (presenceNorm > 0.02) {
      const aureolaR = (NODE_R + presenceNorm * 12) * scale;
      ctx.beginPath();
      ctx.arc(node.x, node.y, aureolaR, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.globalAlpha = effectiveAlpha * 0.3 * presenceNorm;
      ctx.fill();
    }

    // Node circle
    const r = (isSelected ? NODE_R + 1.5 : NODE_R) * scale;
    ctx.globalAlpha = effectiveAlpha;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();

    // Label (flashcard labels hidden unless hovered/selected)
    const showLabel = node.type !== 'Flashcard' || isSelected || isHovered;
    if (globalScale >= 0.8 && showLabel) {
      ctx.globalAlpha = effectiveAlpha;
      const fontSize = Math.min(14, Math.max(10, 12 / globalScale));
      ctx.font = `${fontSize}px Geist, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = colors.label;
      ctx.fillText(node.name, node.x, node.y + r + 2);
    }

    ctx.globalAlpha = 1;
  }, [colors, focusedIds, selected, hovered]);

  const getLinkColor = useCallback(link => {
    const base = colors.links[link.relation] ?? colors.links.connection;
    if (!focusedIds) return withAlpha(base, 0.45);
    const focused = focusedIds.has(nodeId(link.source)) || focusedIds.has(nodeId(link.target));
    return focused ? withAlpha(base, 0.7) : withAlpha(base, 0.1);
  }, [colors, focusedIds]);

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
            nodeLabel=""
            nodeColor={node => colors.nodes[node.type] ?? colors.nodes.Document}
            nodeRelSize={7}
            nodeCanvasObjectMode={() => 'replace'}
            nodeCanvasObject={paintNode}
            autoPauseRedraw={false}
            linkColor={getLinkColor}
            linkDirectionalArrowColor={getLinkColor}
            linkWidth={1.5}
            linkHoverPrecision={8}
            linkDirectionalArrowLength={link => DIRECTED.has(link.relation) ? 5 : 0}
            linkDirectionalArrowRelPos={1}
            linkLabel={link => link.relation}

            onNodeClick={handleNodeClick}
            onNodeHover={handleNodeHover}
            onBackgroundClick={() => {
              selectedByHoverRef.current = false;
              setSelected(null);
            }}
          />

          <div className="graph-controls">
            {Object.entries(colors.nodes).map(([type, color]) => (
              <div key={type} className="graph-controls-item">
                <span className="graph-controls-dot" style={{ background: color }} />
                <span>{type}</span>
              </div>
            ))}

            <div className="graph-controls-sep" />

            <button type="button"
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

            <button type="button"
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

            <button type="button"
              className={`graph-toggle-btn${showDecks ? ' graph-toggle-btn--active' : ''}`}
              onClick={() => setShowDecks(s => !s)}
              title={showDecks ? 'Hide deck connections' : 'Show deck connections'}
            >
              <span className="graph-controls-dot" style={{
                background: colors.nodes.Deck,
                opacity: showDecks ? 1 : 0.25,
              }} />
              <span>decks</span>
            </button>
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
                            return (
                              <span
                                key={n.id}
                                className={`graph-info-neighbor${canNavigate ? ' graph-info-neighbor--link' : ''}`}
                                title={n.type === 'Flashcard' && n.flashcardFront ? n.flashcardFront : n.name}
                                onClick={handleChipClick}
                              >
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
