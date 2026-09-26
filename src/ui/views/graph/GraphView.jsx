/**
 * GraphView — the knowledge graph: a force-directed canvas of documents,
 * folders, cards, tags and decks, lit by how well each is learned. Data, painting
 * and forces live in graphData.js / paint.js / forces.js; this composes them with
 * the controls panel and the selection panel.
 */

import { useEffect, useRef, useCallback, useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import ProgressScopePicker from '../../components/account/ProgressScopePicker';
import useContainerSize from '../../hooks/useContainerSize';
import usePersisted from '../../hooks/usePersisted';
import useThemeVersion from '../../hooks/useThemeVersion';
import { useT } from '../../translations/index';
import { applyVisibility, focusedIdsFor, neighborGroupsFor } from './graphData.js';
import {
  paintNode, paintHalos, newAnimState, blendModeFor, labelMinScaleFor, restAlphaFor, linkWidthFor,
  linkColorsFor, linkColor, linkDash,
} from './paint.js';
import { readGraphPalette } from './palette.js';
import { datestamp, downloadBlob, exportJson, exportShape, generateGraphHtml } from './export.js';
import useGraph from './useGraph';
import useGraphAnimation from './useGraphAnimation';
import useGraphSelection from './useGraphSelection';
import useForceLayout from './useForceLayout';
import useGraphLabels from './useGraphLabels';
import GraphControls from './GraphControls';
import GraphInfo from './GraphInfo';
import './GraphView.css';

const NODE_PAINT_MODE = () => 'replace';
const DEFAULT_COHESION = 0.6;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Every knob in the controls panel is a preference: localStorage, never config.json. */
const LS = {
  tags: 'fb-graph-show-tags',
  decks: 'fb-graph-show-decks',
  links: 'fb-graph-show-links',
  origin: 'fb-graph-show-origin',
  defaultDeck: 'fb-graph-show-default-deck',
  bloom: 'fb-graph-bloom',
  cohesion: 'fb-graph-cohesion',
  collapsed: 'fb-graph-controls-collapsed',
};

function KofiLink() {
  const { t } = useT();
  return (
    <a className="graph-kofi" href="https://ko-fi.com/D1J122ME9O" target="_blank" rel="noreferrer" title={t('Support Flashback on Ko-fi')}>
      <svg className="graph-kofi-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 5h13a3 3 0 0 1 0 6h-1.2A5 5 0 0 1 11 15H8a4 4 0 0 1-4-4V5Z" fill="currentColor" opacity="0.28" />
        <path d="M4.5 5.5h12.5a2.5 2.5 0 0 1 0 5H15.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M4.5 5.5v5.5A3.5 3.5 0 0 0 8 14.5h3a3.5 3.5 0 0 0 3.5-3.5V5.5H4.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M8 3c0 .8-.9.9-.9 1.8M11 3c0 .8-.9.9-.9 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
        <path d="M6 18h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.5" />
      </svg>
      <span className="graph-kofi-label">{t('Support me on Ko-fi')}</span>
    </a>
  );
}

export default function GraphView({ isActive = false, onNavigate, viewingAccount = null, onViewingAccountChange }) {
  const { t, tp, locale } = useT();
  const { typeLabel, relationLabel } = useGraphLabels();
  const { graphData, loading, error, refresh } = useGraph(isActive, viewingAccount?.id ?? null);
  const [showTags, setShowTags] = usePersisted(LS.tags, true);
  const [showDecks, setShowDecks] = usePersisted(LS.decks, true);
  const [showLinks, setShowLinks] = usePersisted(LS.links, true);
  const [showOrigin, setShowOrigin] = usePersisted(LS.origin, true);
  const [showDefaultDeck, setShowDefaultDeck] = usePersisted(LS.defaultDeck, true);
  const [bloom, setBloom] = usePersisted(LS.bloom, false);
  const [cohesion, setCohesion] = usePersisted(LS.cohesion, DEFAULT_COHESION, clamp01);
  const [collapsed, setCollapsed] = usePersisted(LS.collapsed, false);
  const containerRef = useRef(null);
  const fgRef = useRef(null);
  const animRef = useRef(newAnimState());
  const { animating, nudge } = useGraphAnimation();
  const selection = useGraphSelection();
  const { width, height } = useContainerSize(containerRef);
  const themeVer = useThemeVersion();

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const colors = useMemo(() => readGraphPalette(), [themeVer]);

  const visibleData = useMemo(
    () => (graphData ? applyVisibility(graphData, { showTags, showDecks, showLinks, showOrigin, showDefaultDeck }) : null),
    [graphData, showTags, showDecks, showLinks, showOrigin, showDefaultDeck]
  );
  const { selected, hovered } = selection;
  const focusedIds = useMemo(() => focusedIdsFor(selected, visibleData), [selected, visibleData]);
  const neighborGroups = useMemo(() => neighborGroupsFor(selected, visibleData), [selected, visibleData]);

  useEffect(() => { nudge(900); }, [visibleData, nudge]);
  useEffect(() => { nudge(700); }, [hovered, selected, nudge]);
  useForceLayout(fgRef, visibleData, cohesion);

  const nodeCount = visibleData?.nodes.length ?? 0;
  const linkCount = visibleData?.links.length ?? 0;
  const labelMinScale = labelMinScaleFor(nodeCount);
  const blendMode = blendModeFor(colors.bg);
  const linkColors = useMemo(() => linkColorsFor(colors, restAlphaFor(linkCount)), [colors, linkCount]);

  const nodePainter = useCallback((node, ctx, globalScale) => paintNode(node, ctx, globalScale, {
    colors, focusedIds, selectedId: selected?.id, hoveredId: hovered?.id, labelMinScale, anim: animRef.current,
  }), [colors, focusedIds, selected, hovered, labelMinScale]);

  const haloPainter = useCallback((ctx) => paintHalos(ctx, {
    nodes: visibleData?.nodes, colors, blendMode, bloom, anim: animRef.current,
  }), [visibleData, colors, blendMode, bloom]);

  const getLinkColor = useCallback((link) => linkColor(link, linkColors, focusedIds), [linkColors, focusedIds]);

  const handleExport = (kind) => {
    if (kind === 'png') {
      const canvas = containerRef.current?.querySelector('canvas');
      canvas?.toBlob((blob) => { if (blob) downloadBlob(blob, `flashback-graph-${datestamp()}.png`); }, 'image/png');
      return;
    }
    if (!visibleData) return;
    if (kind === 'json') {
      downloadBlob(new Blob([JSON.stringify(exportJson(visibleData), null, 2)], { type: 'application/json' }), `flashback-graph-${datestamp()}.json`);
      return;
    }
    const { nodes, links } = exportShape(visibleData);
    const html = generateGraphHtml(nodes, links, colors, {
      lang: locale,
      title: t('Flashback Knowledge Graph'),
      meta: t('Exported {date} · {nodes} · {edges}', {
        date: new Date().toLocaleString(locale),
        nodes: tp('{n} node', '{n} nodes', nodes.length),
        edges: tp('{n} edge', '{n} edges', links.length),
      }),
      typeLabels: { Document: t('Document'), Folder: t('Folder'), Flashcard: t('Flashcard'), Tag: t('Tag'), Deck: t('Deck') },
      toggleLabels: { Tag: t('Tags'), Deck: t('Decks') },
    });
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `flashback-graph-${datestamp()}.html`);
  };

  const filters = {
    origin: { on: showOrigin, toggle: () => setShowOrigin((s) => !s) },
    defaultDeck: { on: showDefaultDeck, toggle: () => setShowDefaultDeck((s) => !s) },
    decks: { on: showDecks, toggle: () => setShowDecks((s) => !s) },
    tags: { on: showTags, toggle: () => setShowTags((s) => !s) },
    links: { on: showLinks, toggle: () => setShowLinks((s) => !s) },
  };

  const hasGraph = !loading && !error && nodeCount > 0;

  return (
    <div className="graph-view">
      <div className="graph-topbar">
        {onViewingAccountChange && <ProgressScopePicker note value={viewingAccount} onChange={onViewingAccountChange} />}
      </div>
      <div ref={containerRef} className="graph-root">
        {loading && <div className="graph-status">{t('Loading graph…')}</div>}
        {error && (
          <div className="graph-status graph-status--error">
            {viewingAccount && error.status === 404
              ? t("This server can't show another person's graph yet — it needs updating to the current release.")
              : t('Error: {message}', { message: error.message })}
            {viewingAccount && onViewingAccountChange && (
              <button type="button" className="btn btn--sm graph-status-action" onClick={() => onViewingAccountChange(null)}>
                {t('Show your own graph')}
              </button>
            )}
          </div>
        )}
        {!loading && !error && nodeCount === 0 && (
          <div className="graph-status">{t("Nothing to see here. You're empty inside. Just like me.")}</div>
        )}
        {hasGraph && (
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
              nodeCanvasObject={nodePainter}
              onRenderFramePre={haloPainter}
              autoPauseRedraw={!animating}
              cooldownTime={nodeCount > 800 ? 8000 : 15000}
              linkColor={getLinkColor}
              linkLineDash={linkDash}
              linkWidth={linkWidthFor(linkCount)}
              d3AlphaDecay={nodeCount > 800 ? 0.05 : 0.0228}
              d3VelocityDecay={0.45}
              onNodeClick={selection.onClick}
              onNodeHover={selection.onHover}
              onBackgroundClick={selection.clear}
            />
            <KofiLink />
            <GraphControls
              colors={colors}
              typeLabel={typeLabel}
              filters={filters}
              hasDefaultDeck={graphData?.defaultDeckIds?.size > 0}
              bloom={bloom}
              setBloom={setBloom}
              cohesion={cohesion}
              setCohesion={setCohesion}
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              loading={loading}
              onRefresh={refresh}
              onExport={handleExport}
            />
            {selected && (
              <GraphInfo
                selected={selected}
                groups={neighborGroups}
                colors={colors}
                typeLabel={typeLabel}
                relationLabel={relationLabel}
                onNavigate={onNavigate}
                onClose={selection.clear}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
