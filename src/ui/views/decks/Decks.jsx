/**
 * Decks — the deck list beside the selected deck's detail, plus creating a deck
 * and importing an Anki package or Obsidian vault (the same package flow the
 * file explorer uses, from hooks/useImports.js).
 */

import { useState, useEffect, useRef } from 'react';
import AnkiMappingModal from '../../components/deck/AnkiMappingModal';
import ProgressDialog from '../../components/base/ProgressDialog';
import useImports from '../../hooks/useImports';
import { useSession } from '../../sessionContext.js';
import { useT } from '../../translations/index';
import useDecks from './useDecks';
import DeckDetail from './DeckDetail';
import { NewDeckForm } from './DeckPanels';
import './Decks.css';

const ImportIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="M12 12L8 8L4 12" />
    <line x1="8" y1="8" x2="8" y2="15" />
    <rect x="2" y="2" width="12" height="4" rx="1" />
  </svg>
);

/** One deck in the list: its name, the system badge, and its card count. */
function DeckListItem({ deck, active, onSelect }) {
  const { t, tp } = useT();
  return (
    <div className={`deck-item${active ? ' active' : ''}`} onClick={onSelect}>
      <span className="deck-item-icon">▤</span>
      <div className="deck-item-info">
        <div className="deck-item-name">
          {deck.name}
          {deck.is_system ? <span className="badge badge--accent">{t('default')}</span> : null}
        </div>
        <div className="deck-item-count">{tp('{n} card', '{n} cards', deck.entry_count)}</div>
      </div>
    </div>
  );
}

export default function DecksView({ onStudyDeck, openDeck, onOpenDeckConsumed }) {
  const { t } = useT();
  const { can } = useSession();
  const { decks, loading, error, refresh, version } = useDecks();
  const imports = useImports();
  const [activeDeck, setActiveDeck] = useState(null);
  const [creating, setCreating] = useState(false);
  const importInputRef = useRef(null);

  useEffect(() => {
    if (!openDeck) return;
    setActiveDeck(openDeck);
    setCreating(false);
    onOpenDeckConsumed?.();
  }, [openDeck, onOpenDeckConsumed]);

  const select = (hash) => { setActiveDeck(hash); setCreating(false); };
  const handleCreated = (hash) => { setCreating(false); refresh(); setActiveDeck(hash); };
  const handleDeleted = () => { setActiveDeck(null); refresh(); };
  const handleStudy = (deck) => onStudyDeck?.({ deck: deck.global_hash, deckName: deck.name });

  const importError = imports.error && t('Couldn’t import "{name}". {reason}', {
    name: imports.error.filename ?? '',
    reason: imports.error.message || t('The file may be unsupported or corrupt.'),
  });

  return (
    <div className="decks-view">
      <div className="decks-panel">
        <div className="header-row decks-panel-header">
          <span className="decks-panel-title">{t('Decks')}</span>
          <div className="decks-panel-actions">
            {can('importDocuments') && (
              <button type="button" className="btn btn--ghost btn--icon btn--sm" title={t('Import an Anki deck (.apkg) or Obsidian vault (.zip)')} onClick={() => importInputRef.current?.click()} aria-label={t('Import deck')}>
                <ImportIcon />
              </button>
            )}
            {can('manageDecks') && (
              <button type="button" className="btn btn--ghost btn--icon btn--sm" title={t('New deck')} onClick={() => { setCreating(true); setActiveDeck(null); }}>+</button>
            )}
          </div>
          <input
            ref={importInputRef}
            type="file"
            accept=".apkg,.zip"
            style={{ display: 'none' }}
            onChange={(e) => { imports.importFiles(Array.from(e.target.files || []), ''); e.target.value = ''; }}
          />
        </div>

        <div className="decks-list">
          {loading && <div className="decks-empty">{t('Loading…')}</div>}
          {!loading && error && (
            <div className="decks-empty decks-empty--error">
              <span>{t('Failed to load decks.')}</span>
              <button type="button" className="btn btn--sm" onClick={refresh}>{t('Try again')}</button>
            </div>
          )}
          {!loading && !error && decks.length === 0 && !creating && (
            <div className="decks-empty">
              {t('No decks yet.')}
              {can('manageDecks') && <><br />{t('Click + to create one.')}</>}
            </div>
          )}
          {decks.map((deck) => (
            <DeckListItem key={deck.global_hash} deck={deck} active={activeDeck === deck.global_hash} onSelect={() => select(deck.global_hash)} />
          ))}
        </div>
      </div>

      <div className="deck-content">
        {creating ? (
          <>
            <div className="deck-detail-header">
              <div className="deck-detail-title-group"><h2 className="deck-detail-name">{t('New Deck')}</h2></div>
            </div>
            <NewDeckForm onCreated={handleCreated} onCancel={() => setCreating(false)} />
          </>
        ) : activeDeck ? (
          <DeckDetail key={`${activeDeck}:${version}`} deckHash={activeDeck} onDeleted={handleDeleted} onRefreshList={refresh} onStudy={handleStudy} />
        ) : (
          <div className="deck-empty-state">
            <div className="deck-empty-icon">▤</div>
            <div className="deck-empty-text">{t('Select a deck or create a new one to get started.')}</div>
          </div>
        )}
      </div>

      {imports.importing && (
        <ProgressDialog
          title={t('Importing deck')}
          filename={imports.importing.filename}
          progress={imports.importing.pct}
          processing={imports.importing.processing}
          statusText={imports.importing.processing ? t('Processing…') : t('Uploading… {percent}%', { percent: imports.importing.pct })}
        />
      )}
      {importError && (
        <div className="decks-import-error" role="alert">
          <span>{importError}</span>
          <button type="button" className="btn-close" onClick={imports.clearError} aria-label={t('Dismiss')}>×</button>
        </div>
      )}
      {imports.ankiMapping && (
        <AnkiMappingModal
          report={imports.ankiMapping.report}
          filename={imports.ankiMapping.filename}
          importing={imports.ankiBusy}
          error={imports.ankiError}
          onCancel={imports.cancelMapping}
          onConfirm={imports.applyMapping}
        />
      )}
    </div>
  );
}
