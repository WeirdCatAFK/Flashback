/**
 * Flashcards — the card browser: level statistics in the sidebar, search, sort,
 * type and health filters, and a paged list of CardRows that open the card
 * detail. State lives in useCardBrowser.js; the filter vocabulary in filters.js.
 */

import { useState } from 'react';
import StandaloneCardModal from '../../components/flashcard/StandaloneCardModal';
import CardDetailModal from '../../components/flashcard/CardDetailModal';
import CardRow from '../../components/flashcard/CardRow';
import { cardTypes, cardTypeLabel, cardAnswerLine } from '../../components/flashcard/flashcardFields';
import { ErrorState } from '../../components/base/StateView';
import ProgressBar from '../../components/base/ProgressBar';
import { useSession } from '../../sessionContext.js';
import { useT } from '../../translations/index';
import { sortOptions, flagFilters, cardBadges } from './filters.js';
import useCardBrowser from './useCardBrowser';
import './Flashcards.css';

function RelativeTime({ iso }) {
  const { formatRelative } = useT();
  if (!iso) return null;
  return <span className="fc-time" title={iso}>{formatRelative(iso)}</span>;
}

function LevelsSidebar({ stats, level, onPick, onClear }) {
  const { t, tp } = useT();
  const totalCards = stats?.total ?? 0;
  const boxes = stats?.boxes ?? [];
  return (
    <div className="fc-sidebar">
      <div className="header-row fc-sidebar-header">
        <span className="eyebrow fc-sidebar-title">{t('Levels')}</span>
        {level !== null && <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>{t('clear')}</button>}
      </div>
      <div className="fc-stats">
        <div className="fc-stats-total">{tp('{n} card total', '{n} cards total', totalCards)}</div>
        {boxes.map((b) => (
          <button
            key={b.level}
            type="button"
            className={`fc-box-row fc-box-btn${level === b.level ? ' fc-box-btn--active' : ''}`}
            onClick={() => onPick(b.level)}
            title={t('Filter to level {n}', { n: b.level })}
          >
            <span className="fc-box-label">{t('L{n}', { n: b.level })}</span>
            <ProgressBar value={totalCards > 0 ? b.count / totalCards : 0} className="fc-box-track" />
            <span className="fc-box-count">{b.count}</span>
          </button>
        ))}
        {stats && stats.masteryPercentage != null && (
          <div
            className="fc-mastery"
            title={t('{mastered} of {total} cards at level {level} or above', { mastered: stats.mastered ?? 0, total: stats.total ?? 0, level: stats.masteryLevel ?? 5 })}
          >
            {t('Mastery {percent}%', { percent: stats.masteryPercentage.toFixed(0) })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function FlashcardsView() {
  const { t, tp } = useT();
  const { can } = useSession();
  const b = useCardBrowser();
  const { filters } = b;
  const [showNewCard, setShowNewCard] = useState(false);
  const [detailHash, setDetailHash] = useState(null);

  return (
    <>
      <div className="flashcards-view">
        <LevelsSidebar stats={b.stats} level={filters.level} onPick={(lv) => b.toggleFilter('level', lv)} onClear={() => b.setFilter('level', null)} />

        <div className="fc-main">
          <div className="toolbar fc-toolbar">
            <input className="field fc-search-input" placeholder={t('Search cards…')} aria-label={t('Search cards')} value={filters.query} onChange={(e) => b.setFilter('query', e.target.value)} />
            <select className="field fc-sort-select" value={filters.sort} onChange={(e) => b.setFilter('sort', e.target.value)} aria-label={t('Sort cards')}>
              {sortOptions(t).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {can('editCards') && (
              <button type="button" className="btn btn--primary" onClick={() => setShowNewCard(true)} title={t('Create a standalone card')}>{t('+ New card')}</button>
            )}
          </div>

          <div className="fc-filter-bar">
            {cardTypes(t).map(({ key, label }) => (
              <button key={key} type="button" className={`btn btn--sm${filters.cardType === key ? ' btn--accent-quiet' : ''}`} onClick={() => b.toggleFilter('cardType', key)}>{label}</button>
            ))}
            <span className="divider-v" aria-hidden="true" />
            {flagFilters(t).map((f) => (
              <button key={f.value} type="button" className={`btn btn--sm fc-flag-pill${filters.flagFilter === f.value ? ' btn--accent-quiet' : ''}`} onClick={() => b.toggleFilter('flagFilter', f.value)} title={f.title}>{f.label}</button>
            ))}
            <span className="fc-filter-count">
              {b.loading ? '…' : tp('{n} card', '{n} cards', b.total)}
              {b.filtered && !b.loading && ` ${t('(filtered)')}`}
            </span>
            {b.filtered && <button type="button" className="btn btn--ghost btn--sm" onClick={b.clearFilters}>{t('Clear filters')}</button>}
          </div>

          <div className="fc-card-list">
            {b.cards.map((card) => (
              <CardRow
                key={card.global_hash}
                level={card.level ?? 0}
                front={card.frontText || card.name}
                back={cardAnswerLine(card)}
                highlighted={!card.document_name}
                title={t('Open card details')}
                onOpen={() => setDetailHash(card.global_hash)}
                badges={cardBadges({ ...card, typeLabel: cardTypeLabel(card.card_type, t) }, t)}
                actions={
                  <>
                    <RelativeTime iso={card.last_recall} />
                    {can('editCards') && (
                      <button
                        type="button"
                        className="btn-close"
                        title={card.document_name ? t('Delete card from {document}', { document: card.document_name }) : t('Delete card')}
                        onClick={() => b.remove(card)}
                      >
                        ✕
                      </button>
                    )}
                  </>
                }
              />
            ))}
            {!b.loading && b.error && <ErrorState error={b.error} title={t("Couldn't load your cards")} onRetry={b.reload} />}
            {!b.loading && !b.error && b.cards.length === 0 && <div className="fc-empty">{t('No cards found.')}</div>}
          </div>

          {b.totalPages > 1 && (
            <div className="fc-pagination">
              <button type="button" className="btn btn--sm" disabled={b.page === 0} onClick={() => b.setPage((p) => p - 1)}>{t('‹ Prev')}</button>
              <span className="fc-page-info">{t('{page} / {total}', { page: b.page + 1, total: b.totalPages })}</span>
              <button type="button" className="btn btn--sm" disabled={b.page >= b.totalPages - 1} onClick={() => b.setPage((p) => p + 1)}>{t('Next ›')}</button>
            </div>
          )}
        </div>
      </div>
      {detailHash && <CardDetailModal hash={detailHash} onClose={() => setDetailHash(null)} onSaved={b.reloadAll} />}
      {showNewCard && <StandaloneCardModal onClose={() => setShowNewCard(false)} onCreated={() => { setShowNewCard(false); b.reload(); }} />}
    </>
  );
}
