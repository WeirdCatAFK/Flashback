/**
 * Flashcards — the catalogue: every card you own, wherever it lives, to find, check
 * and fix. The sources are drawn like the file tree (documents, then the default
 * deck), with the gap between reviews and card health beneath; the search is the
 * screen. A card opens in the card editor, or in its details for someone who may
 * not edit. State lives in useCardBrowser.js; the vocabulary in catalogue.js.
 */

import { useEffect, useRef, useState } from 'react';
import CardBench from '../../components/flashcard/CardBench';
import CardDetailModal from '../../components/flashcard/CardDetailModal';
import CardLine from '../../components/flashcard/CardLine';
import { cardTypes, cardTypeLabel } from '../../components/flashcard/flashcardFields';
import { ErrorState } from '../../components/base/StateView';
import IconFolder from '../../components/icons/IconFolder';
import IconFolderOpen from '../../components/icons/IconFolderOpen';
import IconDecks from '../../components/icons/IconDecks';
import IconFlashcards from '../../components/icons/IconFlashcards';
import getFileIcon from '../../components/icons/fileIconMap';
import { useSession } from '../../sessionContext.js';
import { useT } from '../../translations/index';
import {
  bandOptions, healthOptions, sortOptions, groupOptions, buildSourceTree, scopeParts, NO_NARROWING,
  withGroupHeaders, groupLabel, share, MAX_SHOWN,
} from './catalogue.js';
import useCardBench from '../../components/flashcard/useCardBench';
import useCardBrowser from './useCardBrowser';
import './Flashcards.css';

/** A card count: a small card outline and the number. */
function Count({ n }) {
  return <span className="fc-count"><i aria-hidden="true" />{n}</span>;
}

/** The thin line under a row: long-term share for a source, library share for a band. */
function Line({ value }) {
  return <span className="fc-line-bar" aria-hidden="true"><i style={{ width: `${Math.round(value * 100)}%` }} /></span>;
}

/** One row of the sources tree. */
function SourceRow({ depth = 0, icon, name, cards, line, selected, expanded, onToggle, onChoose, title }) {
  return (
    <div
      className={`fc-src-row${selected ? ' is-selected' : ''}`}
      role="treeitem"
      tabIndex={0}
      aria-selected={!!selected}
      aria-expanded={expanded}
      style={{ '--depth': depth }}
      title={title}
      onClick={onChoose}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChoose(); }
        if (onToggle && ((e.key === 'ArrowRight' && !expanded) || (e.key === 'ArrowLeft' && expanded))) { e.preventDefault(); onToggle(); }
      }}
    >
      {onToggle ? (
        <button
          type="button"
          className={`fc-chev${expanded ? ' is-open' : ''}`}
          tabIndex={-1}
          aria-hidden="true"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
        />
      ) : <span className="fc-chev-space" />}
      <span className="fc-src-icon">{icon}</span>
      <span className="fc-src-name">{name}</span>
      <Count n={cards} />
      {line != null && <Line value={line} />}
    </div>
  );
}

function SourceTree({ nodes, depth, b }) {
  const { tp } = useT();
  return nodes.map((node) => {
    const sel = b.view.source?.kind === node.kind && b.view.source?.path === node.path;
    const title = tp('{name}: {n} card, {long} long-term', '{name}: {n} cards, {long} long-term', node.cards, { name: node.name, long: node.longTerm });
    if (node.kind === 'document') {
      const Icon = getFileIcon(node.path);
      return (
        <SourceRow key={node.path} depth={depth} icon={<Icon size={14} />} name={node.name} cards={node.cards}
          line={share(node.longTerm, node.cards)} selected={sel} title={title}
          onChoose={() => b.chooseSource({ kind: 'document', path: node.path })} />
      );
    }
    const open = b.openFolders.has(node.path);
    return (
      <div key={node.path} role="none">
        <SourceRow depth={depth} icon={open ? <IconFolderOpen size={14} /> : <IconFolder size={14} />} name={node.name}
          cards={node.cards} line={share(node.longTerm, node.cards)} selected={sel} expanded={open} title={title}
          onToggle={() => b.toggleFolder(node.path)} onChoose={() => b.chooseSource({ kind: 'folder', path: node.path })} />
        {open && <div role="group"><SourceTree nodes={node.children} depth={depth + 1} b={b} /></div>}
      </div>
    );
  });
}

function Sources({ b }) {
  const { t, tp } = useT();
  const s = b.summary;
  const total = s?.total ?? 0;
  const standalone = s?.standalone ?? { cards: 0, longTerm: 0 };
  const tree = s ? buildSourceTree(s.documents) : [];
  const dot = <span className="fc-dot" aria-hidden="true" />;
  return (
    <aside className="fc-side">
      <div className="fc-side-head">
        <span className="eyebrow">{t('Flashcards')}</span>
        <span className="fc-side-total">{total}</span>
      </div>
      <div className="fc-tree" role="tree" aria-label={t('Where your cards are')}>
        <SourceRow icon={<IconFlashcards size={14} />} name={t('All cards')} cards={total}
          selected={!b.view.source} onChoose={() => b.chooseSource(null)} />

        {tree.length > 0 && <div className="fc-tree-label" role="presentation">{t('Documents')}</div>}
        <SourceTree nodes={tree} depth={0} b={b} />

        <div className="fc-tree-label" role="presentation">{t('Default deck')}</div>
        <SourceRow icon={<IconDecks size={14} />} name={t('Cards')} cards={standalone.cards}
          line={share(standalone.longTerm, standalone.cards)}
          selected={b.view.source?.kind === 'standalone'}
          title={t('Cards: the default deck. Cards made without a document live here.')}
          onChoose={() => b.chooseSource({ kind: 'standalone', path: null })} />

        <div className="fc-tree-label" role="presentation">{t('Gap between reviews')}</div>
        {bandOptions(t).map((band) => {
          const n = s?.bands?.[band.id] ?? 0;
          return (
            <SourceRow key={band.id} icon={dot} name={band.label} cards={n} line={share(n, total)}
              selected={b.view.band === band.id}
              title={tp('{name}: {n} card', '{name}: {n} cards', n, { name: band.label })}
              onChoose={() => b.update({ band: b.view.band === band.id ? null : band.id })} />
          );
        })}

        <div className="fc-tree-label" role="presentation">{t('Health')}</div>
        {healthOptions(t).map((h) => (
          <SourceRow key={h.id} icon={dot} name={h.label} cards={s?.flags?.[h.id] ?? 0}
            selected={b.view.health === h.id} title={h.title}
            onChoose={() => b.update({ health: b.view.health === h.id ? null : h.id })} />
        ))}
      </div>
    </aside>
  );
}

export default function FlashcardsView({ isActive = true, onOpenSource, request = null, onRequestConsumed }) {
  const { t, tp } = useT();
  const { can } = useSession();
  const canEdit = can('editCards');
  const b = useCardBrowser({ isActive, onOpenSource });
  const bench = useCardBench();
  const { view } = b;
  const [detailHash, setDetailHash] = useState(null);
  const searchRef = useRef(null);

  /** Another screen asked for some cards (a band from Statistics, a tag or category from Metadata): start from that alone. */
  useEffect(() => {
    if (!request) return;
    b.update({ ...NO_NARROWING, ...request });
    onRequestConsumed?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  useEffect(() => {
    if (!isActive) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  const scope = scopeParts(view, t, (k) => cardTypeLabel(k, t));
  const libraryTotal = b.summary?.total ?? b.total;
  const rows = withGroupHeaders(b.cards, view.group, b.groups);
  const open = (card) => (canEdit ? bench.openEdit(card.global_hash) : setDetailHash(card.global_hash));

  return (
    <>
      <div className="flashcards-view">
        <Sources b={b} />

        <div className="fc-main">
          <div className="fc-search">
            <input
              ref={searchRef}
              type="search"
              placeholder={t('Search every card…')}
              aria-label={t('Search cards')}
              value={view.query}
              onChange={(e) => b.update({ query: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape' && view.query) { e.stopPropagation(); b.update({ query: '' }); } }}
            />
          </div>

          <div className="fc-bar">
            <span className="fc-bar-count">
              <b>{b.total}</b> {tp('of {n} card', 'of {n} cards', libraryTotal)}
              {scope.length > 0 && <span className="fc-bar-scope"> · {scope.join(' · ')}</span>}
            </span>
            <label className="fc-bar-field">
              {t('Type')}
              <select className="fc-select" value={view.cardType} onChange={(e) => b.update({ cardType: e.target.value })}>
                <option value="">{t('Any type')}</option>
                {cardTypes(t).map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <label className="fc-bar-field">
              {t('Sort')}
              <select className="fc-select" value={view.sort} onChange={(e) => b.update({ sort: e.target.value })}>
                {sortOptions(t).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="fc-bar-field">
              {t('Group by')}
              <select className="fc-select" value={view.group} onChange={(e) => b.update({ group: e.target.value })}>
                {groupOptions(t).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            {b.narrowed && <button type="button" className="link-action" onClick={b.clear}>{t('Clear')}</button>}
            <span className="fc-bar-grow" />
            {canEdit && (
              <button type="button" className="btn btn--quiet-accent btn--sm" onClick={bench.openNew} title={t('A card with no document goes to Cards, the default deck')}>
                {t('New card')}
              </button>
            )}
          </div>

          <div className="fc-list" role="list" aria-busy={b.loading}>
            {rows.map((r) => (r.header ? (
              <div key={`h:${r.key}`} className="fc-group" role="presentation">
                <span>{groupLabel(view.group, r.key, t)}</span>
                <span className="fc-group-n">{r.count}</span>
              </div>
            ) : (
              <CardLine
                key={r.card.global_hash}
                card={r.card}
                onOpen={() => open(r.card)}
                actions={(
                  <>
                    {r.card.document_path && <button type="button" className="link-action" onClick={() => b.openSource(r.card)}>{t('Open source')}</button>}
                    <button type="button" className="link-action" onClick={() => setDetailHash(r.card.global_hash)}>{t('Details')}</button>
                    {canEdit && <button type="button" className="link-action" onClick={() => bench.openEdit(r.card.global_hash)}>{t('Edit')}</button>}
                  </>
                )}
              />
            )))}
            {!b.loading && b.error && <ErrorState error={b.error} title={t("Couldn't load your cards")} onRetry={b.reload} />}
            {!b.loading && !b.error && b.cards.length === 0 && (
              <p className="fc-empty">
                {view.query ? t('No card matches “{query}”.', { query: view.query.trim() }) : b.narrowed ? t('No cards here.') : t('No cards here yet.')}
              </p>
            )}
            {b.hasMore && (
              b.cards.length < MAX_SHOWN
                ? <button type="button" className="btn btn--quiet btn--sm fc-more" onClick={b.showMore}>{t('Show more')}</button>
                : <p className="fc-empty">{t('Showing the first {n}. Search or pick a source to narrow the list.', { n: MAX_SHOWN })}</p>
            )}
          </div>

          {bench.benchProps && <CardBench key={bench.benchKey} {...bench.benchProps} />}
        </div>
      </div>
      {detailHash && <CardDetailModal hash={detailHash} onClose={() => setDetailHash(null)} onSaved={b.reload} />}
    </>
  );
}
