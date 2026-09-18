/**
 * DeckDetail — one deck's pane: name and description (editable in place by a
 * deck manager), its tags, its cards as CardRows, and the study / add / erase
 * actions. State and mutations live in useDeckDetail.js.
 */

import StandaloneCardModal from '../../components/flashcard/StandaloneCardModal';
import CardRow from '../../components/flashcard/CardRow';
import { cardTypeLabel, cardAnswerLine } from '../../components/flashcard/flashcardFields';
import DeckPurgeDialog from '../../components/deck/DeckPurgeDialog';
import { LoadingState, ErrorState } from '../../components/base/StateView';
import { useSession } from '../../sessionContext.js';
import { useT } from '../../translations/index';
import { Rich } from '../../translations/components.jsx';
import useDeckDetail from './useDeckDetail';
import { AddCardsPanel, DeckTags } from './DeckPanels';

/** The last segment of a document path, either separator. */
const docName = (p) => (p ? p.split('/').pop().split('\\').pop() : null);

function DeckMetaForm({ d }) {
  const { t } = useT();
  return (
    <form className="deck-meta-form" onSubmit={d.submitMeta} onKeyDown={(e) => { if (e.key === 'Escape') d.setEditingMeta(false); }}>
      <input className="field deck-detail-name-input" autoFocus aria-label={t('Deck name')} value={d.nameVal} onChange={(e) => d.setNameVal(e.target.value)} placeholder={t('Deck name')} />
      <textarea className="field deck-detail-desc-input" aria-label={t('Deck description')} value={d.descVal} onChange={(e) => d.setDescVal(e.target.value)} rows={2} placeholder={t('Optional description')} />
      <div className="deck-meta-form-actions">
        <button type="button" className="btn" onClick={() => d.setEditingMeta(false)} disabled={d.savingMeta}>{t('Cancel')}</button>
        <button type="submit" className="btn btn--primary" disabled={d.savingMeta || !d.nameVal.trim()}>{d.savingMeta ? t('Saving…') : t('Save')}</button>
      </div>
    </form>
  );
}

export default function DeckDetail({ deckHash, onDeleted, onRefreshList, onStudy }) {
  const { t, tp } = useT();
  const { can } = useSession();
  const d = useDeckDetail({ deckHash, onDeleted, onRefreshList });
  const { deck } = d;
  const manages = can('manageDecks');

  if (d.loading) return <div className="deck-content"><LoadingState message={t('Loading deck…')} /></div>;
  if (d.error) return <div className="deck-content"><ErrorState error={d.error} title={t("Couldn't load this deck")} onRetry={d.load} /></div>;
  if (!deck) return null;

  const existingHashes = new Set((deck.entries || []).map((e) => e.card_hash));
  const editHint = manages ? t('Double-click to edit') : undefined;

  return (
    <>
      <div className="deck-content" style={{ position: 'relative' }}>
        <div className="deck-detail-header">
          <div className="deck-detail-title-group">
            {d.editingMeta ? <DeckMetaForm d={d} /> : (
              <>
                <h2 className="deck-detail-name" onDoubleClick={manages ? d.startEditMeta : undefined} title={editHint}>{deck.name}</h2>
                <div className="deck-detail-meta">
                  {tp('{n} card', '{n} cards', deck.entries?.length ?? 0)}
                  {' · '}
                  <span
                    className={`deck-detail-desc${deck.description ? '' : ' deck-detail-desc--empty'}`}
                    onDoubleClick={manages ? d.startEditMeta : undefined}
                    title={editHint}
                  >
                    {deck.description || (manages ? t('Add a description…') : '')}
                  </span>
                  {!!deck.is_system && <span className="badge badge--accent deck-system-badge--detail">{t('Standalone cards live here')}</span>}
                </div>
              </>
            )}
          </div>
          <div className="deck-detail-actions">
            {deck.entries?.length > 0 && <button type="button" className="btn btn--primary" onClick={() => onStudy(deck)}>{t('▶ Study')}</button>}
            {!!deck.is_system && can('editCards') && <button type="button" className="btn" onClick={() => d.setShowNewCard(true)}>{t('+ New card')}</button>}
            {manages && <button type="button" className="btn" onClick={d.toggleAddPanel}>{t('+ Add cards')}</button>}
            {!deck.is_system && manages && (
              <>
                <button type="button" className="btn btn--danger-quiet" onClick={d.remove}>{t('Delete')}</button>
                <button type="button" className="btn btn--danger-quiet" onClick={() => d.setPurging(true)}>{t('Erase')}</button>
              </>
            )}
          </div>
        </div>

        <DeckTags deckHash={deckHash} tags={deck.tags || []} onChanged={d.changed} />

        <div className="deck-cards-area">
          {deck.entries?.length === 0 ? (
            <div className="deck-cards-empty">
              {t('This deck is empty.')}<br />
              <Rich text={t('Click {action} to pick cards from your library.')} values={{ action: <strong>{t('+ Add cards')}</strong> }} />
            </div>
          ) : (
            deck.entries.map((entry) => (
              <CardRow
                key={entry.card_hash}
                level={entry.level ?? 0}
                front={entry.frontText || entry.card_name}
                back={cardAnswerLine(entry)}
                badges={[
                  ...(entry.card_type && entry.card_type !== 'basic' ? [{ key: 'type', label: cardTypeLabel(entry.card_type, t) }] : []),
                  ...(entry.document_path ? [{ key: 'doc', label: docName(entry.document_path), title: entry.document_path, tone: 'outline' }] : []),
                ]}
                actions={manages && (
                  <button type="button" className="btn-close" title={t('Remove from deck')} aria-label={t('Remove from deck')} onClick={() => d.removeCard(entry.card_hash)}>×</button>
                )}
              />
            ))
          )}
        </div>

        {d.showAddPanel && (
          <AddCardsPanel deckHash={deckHash} existingHashes={existingHashes} onAdded={d.changed} onClose={d.closeAddPanel} />
        )}
      </div>
      {d.showNewCard && (
        <StandaloneCardModal onClose={() => d.setShowNewCard(false)} onCreated={() => { d.setShowNewCard(false); d.changed(); }} />
      )}
      {d.purging && (
        <DeckPurgeDialog deckHash={deckHash} deckName={deck.name} busy={d.purgeBusy} error={d.purgeError} onCancel={d.cancelPurge} onConfirm={d.purge} />
      )}
    </>
  );
}
