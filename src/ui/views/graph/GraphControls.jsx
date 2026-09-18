/**
 * GraphControls — the collapsible panel over the graph: legend, the visibility
 * switches, illumination, cohesion, and Refresh / Export (a Popover menu).
 */

import { useState, useRef } from 'react';
import Popover from '../../components/base/Popover';
import Toggle from '../../components/base/Toggle';
import { useT } from '../../translations/index';

/** A swatch (dot or line) in a legend or switch row. */
function Swatch({ kind = 'dot', color, dim = false }) {
  return <span className={kind === 'line' ? 'graph-controls-line' : 'graph-controls-dot'} style={{ background: color, opacity: dim ? 0.3 : 1 }} />;
}

function FilterRow({ on, onToggle, label, swatch, color, title }) {
  return (
    <Toggle
      checked={on}
      onChange={onToggle}
      className="toggle--trailing graph-filter"
      title={title}
      label={<><Swatch kind={swatch} color={color} dim={!on} /><span className="graph-filter-label">{label}</span></>}
    />
  );
}

export default function GraphControls({
  colors, typeLabel, filters, hasDefaultDeck, bloom, setBloom, cohesion, setCohesion,
  collapsed, setCollapsed, loading, onRefresh, onExport,
}) {
  const { t } = useT();
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef(null);

  const rows = [
    { key: 'origin', label: t('Origin folder'), ...filters.origin, swatch: 'dot', color: colors.nodes.Folder, when: true },
    { key: 'default', label: t('Cards node'), ...filters.defaultDeck, swatch: 'dot', color: colors.nodes.Deck, when: hasDefaultDeck },
    { key: 'decks', label: t('Decks'), ...filters.decks, swatch: 'dot', color: colors.nodes.Deck, when: true },
    { key: 'tags', label: t('Tags'), ...filters.tags, swatch: 'line', color: colors.links.tag, when: true },
    { key: 'links', label: t('Links'), ...filters.links, swatch: 'line', color: colors.links.link, when: true },
  ];

  const pick = (kind) => { setExportOpen(false); onExport(kind); };

  return (
    <div className={`graph-controls${collapsed ? ' graph-controls--collapsed' : ''}`}>
      <button
        type="button"
        className="graph-controls-toggle"
        onClick={() => { setCollapsed((c) => !c); setExportOpen(false); }}
        aria-expanded={!collapsed}
        title={collapsed ? t('Expand panel') : t('Collapse panel')}
      >
        <svg className="graph-controls-glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="4" cy="4" r="2" fill="currentColor" />
          <circle cx="12" cy="6" r="2" fill="currentColor" />
          <circle cx="6" cy="12" r="2" fill="currentColor" />
          <path d="M4 4L12 6M12 6L6 12M6 12L4 4" stroke="currentColor" strokeWidth="1" opacity="0.5" />
        </svg>
        <span className="graph-controls-title">{t('Graph')}</span>
        <svg className="graph-controls-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="graph-controls-body" hidden={collapsed}>
        <div className="graph-controls-section">
          <div className="eyebrow graph-controls-heading">{t('Legend')}</div>
          {Object.entries(colors.nodes).map(([type, color]) => (
            <div key={type} className="graph-legend-item">
              <Swatch color={color} />
              <span>{typeLabel(type)}</span>
            </div>
          ))}
        </div>

        <div className="graph-controls-section">
          <div className="eyebrow graph-controls-heading">{t('Show')}</div>
          {rows.filter((f) => f.when).map((f) => (
            <FilterRow
              key={f.key}
              on={f.on}
              onToggle={f.toggle}
              label={f.label}
              swatch={f.swatch}
              color={f.color}
              title={f.on ? t('Hide {label}', { label: f.label }) : t('Show {label}', { label: f.label })}
            />
          ))}
        </div>

        <div className="graph-controls-section">
          <div className="eyebrow graph-controls-heading">{t('Illumination')}</div>
          <FilterRow
            on={bloom}
            onToggle={() => setBloom((b) => !b)}
            label={t('Bloom')}
            swatch="dot"
            color={colors.nodes.Flashcard}
            title={bloom ? t('Hide bloom around well-learned nodes') : t('Show bloom around well-learned nodes')}
          />
          <label className="graph-slider-row">
            <span className="graph-slider-label">{t('Cohesion')}</span>
            <input
              type="range"
              className="graph-slider"
              min="0" max="1" step="0.05"
              value={cohesion}
              onChange={(e) => setCohesion(parseFloat(e.target.value))}
              title={t('How tightly related nodes clump together')}
            />
          </label>
        </div>

        <div className="graph-controls-actions">
          <button type="button" className="btn btn--sm" onClick={onRefresh} title={t('Refresh graph data')} disabled={loading}>
            {t('Refresh')}
          </button>
          <button
            ref={exportRef}
            type="button"
            className={`btn btn--sm${exportOpen ? ' btn--accent-quiet' : ''}`}
            onClick={() => setExportOpen((s) => !s)}
            title={t('Export graph')}
            aria-expanded={exportOpen}
          >
            {t('Export')}
          </button>
          <Popover anchorRef={exportRef} open={exportOpen} onClose={() => setExportOpen(false)} align="end">
            <button type="button" className="popover__item" onClick={() => pick('png')}>{t('PNG image')}</button>
            <button type="button" className="popover__item" onClick={() => pick('json')}>{t('JSON data')}</button>
            <button type="button" className="popover__item" onClick={() => pick('html')}>{t('Interactive HTML')}</button>
          </Popover>
        </div>
      </div>
    </div>
  );
}
