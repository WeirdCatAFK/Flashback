/**
 * Decks — boxes you pack to study together. The grid shows every deck as a box in
 * its colour (the default deck, which holds cards made without a document, in
 * kraft); opening one shows its page. Importing an Anki package or Obsidian vault
 * starts here too (the same flow the file explorer uses, from hooks/useImports.js).
 */

import { useState, useEffect, useRef } from 'react';
import AnkiMappingModal from '../../components/deck/AnkiMappingModal';
import DeckBox from '../../components/deck/DeckBox';
import ProgressDialog from '../../components/base/ProgressDialog';
import { ErrorState } from '../../components/base/StateView';
import useImports from '../../hooks/useImports';
import { createDeck } from '../../api/decks';
import { useSession } from '../../sessionContext.js';
import { useT } from '../../translations/index';
import useDecks from './useDecks';
import DeckDetail from './DeckDetail';
import { deckColor, deckStatus, longTermShare, newDeckName } from './deckShelf.js';
import './Decks.css';

/** One deck in the grid: its box, its name, what is due, and its long-term line. */
function DeckTile({ deck, onOpen }) {
  const { t, tp } = useT();
  const status = deckStatus(deck.standing, t, tp);
  const share = longTermShare(deck.standing, deck.entry_count);
  return (
    <button
      type="button"
      className="dk-tile"
      onClick={onOpen}
      title={deck.is_system ? t('Cards: the default deck. Cards made without a document live here.') : (deck.description || deck.name)}
    >
      <DeckBox color={deckColor(deck)} count={deck.entry_count} />
      <span className="dk-name">
        {deck.name}
        {deck.is_system ? <span className="dk-default">{t('default')}</span> : null}
      </span>
      <span className="dk-meta">{status.strong ? <b>{status.text}</b> : status.text}</span>
      <span className="dk-line" aria-hidden="true"><i style={{ width: `${Math.round(share * 100)}%` }} /></span>
    </button>
  );
}

export default function DecksView({ isActive = true, onStudyDeck, openDeck, onOpenDeckConsumed }) {
  const { t, tp } = useT();
  const { can } = useSession();
  const { decks, loading, error, refresh, version } = useDecks({ isActive });
  const imports = useImports();
  const [activeDeck, setActiveDeck] = useState(null);
  const [fresh, setFresh] = useState(null);
  const [note, setNote] = useState('');
  const [creating, setCreating] = useState(false);
  const importInputRef = useRef(null);

  useEffect(() => {
    if (!openDeck) return;
    setActiveDeck(openDeck);
    onOpenDeckConsumed?.();
  }, [openDeck, onOpenDeckConsumed]);

  const open = (hash) => { setActiveDeck(hash); setFresh(null); setNote(''); };
  const back = () => { setActiveDeck(null); setFresh(null); };

  const newDeck = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { globalHash } = await createDeck(newDeckName(decks, t));
      refresh();
      setNote('');
      setActiveDeck(globalHash);
      setFresh(globalHash);
    } catch (err) {
      setNote(err.message ?? String(err));
    } finally {
      setCreating(false);
    }
  };

  const handleDeleted = (name) => {
    setActiveDeck(null);
    setNote(t('Deleted “{name}”. Its cards are still in your library.', { name }));
    refresh();
  };
  const handleStudy = (deck) => onStudyDeck?.({ deck: deck.global_hash, deckName: deck.name });

  const importError = imports.error && t('Couldn’t import "{name}". {reason}', {
    name: imports.error.filename ?? '',
    reason: imports.error.message || t('The file may be unsupported or corrupt.'),
  });

  return (
    <div className="decks-view">
      {activeDeck ? (
        <DeckDetail
          key={activeDeck}
          deckHash={activeDeck}
          version={version}
          fresh={fresh === activeDeck}
          onBack={back}
          onDeleted={handleDeleted}
          onRefreshList={refresh}
          onStudy={handleStudy}
        />
      ) : (
        <>
          <div className="dk-head">
            <h2 className="dk-title">{t('Decks')}</h2>
            {!loading && <span className="dk-sub">{tp('{n} deck · a card can sit in several', '{n} decks · a card can sit in several', decks.length)}</span>}
            <span className="dk-grow" />
            {can('importDocuments') && (
              <button type="button" className="btn btn--quiet btn--sm" title={t('Import an Anki deck (.apkg) or Obsidian vault (.zip)')} onClick={() => importInputRef.current?.click()}>
                {t('Import from Anki')}
              </button>
            )}
            <input
              ref={importInputRef}
              type="file"
              accept=".apkg,.zip"
              hidden
              onChange={(e) => { imports.importFiles(Array.from(e.target.files || []), ''); e.target.value = ''; }}
            />
          </div>
          <div className="dk-body">
            {!loading && error && <ErrorState error={error} title={t('Failed to load decks.')} onRetry={refresh} />}
            {!error && (
              <div className="dk-grid">
                {decks.map((deck) => (
                  <DeckTile key={deck.global_hash} deck={deck} onOpen={() => open(deck.global_hash)} />
                ))}
                {can('manageDecks') && (
                  <button type="button" className="dk-tile dk-add" onClick={newDeck} disabled={creating}>
                    <span className="dk-add-box" aria-hidden="true">+</span>
                    <span className="dk-name">{t('New deck')}</span>
                    <span className="dk-meta">{t('pack cards from anywhere')}</span>
                  </button>
                )}
              </div>
            )}
            {note && <p className="dk-note" role="status">{note}</p>}
          </div>
        </>
      )}

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
