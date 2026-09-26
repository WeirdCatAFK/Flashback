/**
 * DeckDetail — one deck's page: its cover, its box, description, how its cards stand, the
 * study / add / rename / delete / erase actions, its colour and tags, then its
 * cards dealt out as catalogue rows. Adding cards is a layer over the page that
 * searches every card; a card opens in the card editor. State and changes live in
 * useDeckDetail.js.
 */

import { useState } from 'react';
import CardBench from '../../components/flashcard/CardBench';
import CardLine from '../../components/flashcard/CardLine';
import useCardBench from '../../components/flashcard/useCardBench';
import DeckBox from '../../components/deck/DeckBox';
import CoverBanner from '../../components/cover/CoverBanner';
import { deckCoverUrl, uploadDeckCover, setDeckCover, removeDeckCover } from '../../api/decks';
import DeckPurgeDialog from '../../components/deck/DeckPurgeDialog';
import InlineConfirm from '../../components/base/InlineConfirm';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import { useSession } from '../../sessionContext.js';
import { useT } from '../../translations/index';
import useDeckDetail from './useDeckDetail';
import { AddCardsPanel, DeckTags } from './DeckPanels';
import { deckColor, colorOptions, colorName, longTermShare } from './deckShelf.js';

/** How many rows deal in one after another; the rest arrive with the last. */
const DEAL_LIMIT = 12;

/** A text field that commits on Enter or blur and gives up on Escape. */
function InPlaceField({ multiline = false, initial, label, placeholder, className, onDone }) {
  const [value, setValue] = useState(initial);
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <Tag
      className={className}
      autoFocus
      aria-label={label}
      placeholder={placeholder}
      value={value}
      rows={multiline ? 2 : undefined}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); onDone(value); }
        if (e.key === 'Escape') { e.stopPropagation(); onDone(initial); }
      }}
    />
  );
}

export default function DeckDetail({ deckHash, version, fresh = false, onBack, onDeleted, onRefreshList, onStudy }) {
  const { t, tp } = useT();
  const { can } = useSession();
  const d = useDeckDetail({ deckHash, version, fresh, onDeleted, onRefreshList });
  const bench = useCardBench();
  const { deck } = d;
  const manages = can('manageDecks');
  const editsCards = can('editCards');

  const head = (title) => (
    <div className="dk-head">
      <button type="button" className="link-action dk-back" onClick={onBack}>{t('‹ All decks')}</button>
      {title}
    </div>
  );

  if (d.loading) return <>{head(null)}<LoadingState message={t('Loading deck…')} /></>;
  if (d.error) return <>{head(null)}<ErrorState error={d.error} title={t("Couldn't load this deck")} onRetry={d.load} /></>;
  if (!deck) return null;

  const system = !!deck.is_system;
  const entries = deck.entries ?? [];
  const count = entries.length;
  const standing = deck.standing ?? { due: 0, fresh: 0, longTerm: 0 };
  const color = deckColor(deck);
  const existingHashes = new Set(entries.map((e) => e.card_hash));

  const title = d.renaming && manages && !system ? (
    <InPlaceField className="dk-title-input" initial={deck.name} label={t('Deck name')} onDone={d.rename} />
  ) : (
    <h2 className="dk-title">{deck.name}</h2>
  );

  return (
    <>
      {head(title)}
      <div className="dk-body">
        <CoverBanner
          cover={deck.cover}
          tint={color === 'kraft' ? 'var(--color-kraft)' : `var(--color-box-${color})`}
          source={{
            imageUrl: (file) => deckCoverUrl(deckHash, file),
            upload: (file) => uploadDeckCover(deckHash, file),
            set: (change) => setDeckCover(deckHash, change),
            remove: () => removeDeckCover(deckHash),
          }}
          editable={manages}
          onChange={d.setCover}
        />
        <div className="dk-detail">
          <div className="dk-head-row">
            <DeckBox color={color} count={count} size="lg" />
            <div className="dk-info">
              {d.editingDesc ? (
                <InPlaceField multiline className="field dk-desc-input" initial={deck.description ?? ''} label={t('Deck description')} placeholder={t('Optional description')} onDone={d.describe} />
              ) : (
                <p
                  className={`dk-desc${manages && !system ? ' dk-desc--editable' : ''}`}
                  onClick={manages && !system ? () => d.setEditingDesc(true) : undefined}
                  title={manages && !system ? t('Click to edit') : undefined}
                >
                  {system
                    ? t('The default deck. Cards made without a document live here; every other deck only refers to cards.')
                    : deck.description || (manages ? t('Add a description…') : t('No description.'))}
                </p>
              )}

              <div className="dk-facts">
                <span><b>{count}</b> {tp('card', 'cards', count)}</span>
                <span><b>{standing.due}</b> {t('due')}</span>
                {standing.fresh > 0 && <span><b>{standing.fresh}</b> {t('new')}</span>}
                <span><b>{Math.round(longTermShare(standing, count) * 100)}%</b> {t('long-term')}</span>
              </div>

              {d.confirmingDelete ? (
                <InlineConfirm
                  title={t('Delete "{name}"?', { name: deck.name })}
                  message={t('The deck goes; its cards stay in your library.')}
                  busy={d.deleting}
                  onCancel={() => d.setConfirmingDelete(false)}
                  actions={[{ label: t('Delete deck'), kind: 'danger', onClick: d.remove }]}
                />
              ) : (
                <div className="dk-actions">
                  {count > 0 && <button type="button" className="btn btn--quiet-accent btn--sm" onClick={() => onStudy(deck)}>{t('Study')}</button>}
                  {system && editsCards && <button type="button" className="btn btn--quiet btn--sm" onClick={bench.openNew}>{t('New card')}</button>}
                  {manages && (
                    <button type="button" className="btn btn--quiet btn--sm" aria-expanded={d.showAddPanel} onClick={d.toggleAddPanel}>{t('Add cards')}</button>
                  )}
                  {manages && !system && (
                    <>
                      <button type="button" className="btn btn--quiet btn--sm" onClick={() => d.setRenaming(true)}>{t('Rename')}</button>
                      <button type="button" className="btn btn--quiet btn--sm dk-danger" onClick={() => d.setConfirmingDelete(true)}>{t('Delete deck')}</button>
                      <button
                        type="button"
                        className="btn btn--quiet btn--sm dk-danger"
                        title={t('Delete the deck and the cards that live only in it')}
                        onClick={() => d.setPurging(true)}
                      >
                        {t('Erase…')}
                      </button>
                    </>
                  )}
                </div>
              )}
              {d.actionError && <p className="dk-error" role="alert">{d.actionError}</p>}

              <div className="dk-colors" role="group" aria-label={t('Box colour')}>
                <span className="dk-colors-label">{t('Colour')}</span>
                {system ? (
                  <span className="dk-kraft-note">{t('Kraft: the default deck’s colour')}</span>
                ) : colorOptions(t).map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="dk-swatch"
                    style={{ '--sw': `var(--color-box-${c.id})` }}
                    aria-pressed={color === c.id}
                    aria-label={c.label}
                    title={c.label}
                    disabled={!manages}
                    onClick={() => d.recolor(c.id)}
                  />
                ))}
                {!system && <span className="dk-colors-name">{colorName(color, t)}</span>}
              </div>

              <DeckTags deckHash={deckHash} tags={deck.tags || []} onChanged={d.changed} />
            </div>
          </div>

          <div className="dk-cards" role="list">
            {count === 0 ? (
              <p className="dk-empty">{t('This deck is empty. Add cards from anywhere in your library.')}</p>
            ) : entries.map((e, k) => (
              <CardLine
                key={e.card_hash}
                className="card-line--dealt"
                style={{ '--k': Math.min(k, DEAL_LIMIT) }}
                card={{
                  global_hash: e.card_hash,
                  frontText: e.frontText,
                  name: e.card_name,
                  card_type: e.card_type,
                  document_path: e.document_path,
                  gap: e.gap,
                  last_recall: e.last_recall,
                }}
                onOpen={editsCards ? () => bench.openEdit(e.card_hash) : undefined}
                actions={(
                  <>
                    {editsCards && <button type="button" className="link-action" onClick={() => bench.openEdit(e.card_hash)}>{t('Edit')}</button>}
                    {manages && !system && (
                      <button type="button" className="link-action link-action--danger" onClick={() => d.removeCard(e.card_hash)}>{t('Remove from deck')}</button>
                    )}
                  </>
                )}
              />
            ))}
          </div>

          {d.showAddPanel && (
            <AddCardsPanel deckHash={deckHash} deckName={deck.name} existingHashes={existingHashes} onAdded={d.changed} onClose={d.closeAddPanel} />
          )}
        </div>
        {bench.benchProps && <CardBench key={bench.benchKey} {...bench.benchProps} />}
      </div>
      {d.purging && (
        <DeckPurgeDialog deckHash={deckHash} deckName={deck.name} busy={d.purgeBusy} error={d.purgeError} onCancel={d.cancelPurge} onConfirm={d.purge} />
      )}
    </>
  );
}
