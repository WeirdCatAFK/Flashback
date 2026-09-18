/**
 * One deck as the detail pane sees it: its record, and every mutation the pane
 * offers — remove a card, rename/describe, delete, erase (with the shared-card
 * choice). A change to the deck hash resets the add-cards panel.
 */

import { useState, useEffect, useCallback } from 'react';
import { getDeck, updateDeck, deleteDeck, purgeDeck, removeEntry } from '../../api/decks';
import { useConfirm } from '../../components/base/confirmContext.js';
import { useT } from '../../translations/index';

export default function useDeckDetail({ deckHash, onDeleted, onRefreshList }) {
  const { t } = useT();
  const confirm = useConfirm();
  const [deck, setDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [showNewCard, setShowNewCard] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState(null);
  const [editingMeta, setEditingMeta] = useState(false);
  const [nameVal, setNameVal] = useState('');
  const [descVal, setDescVal] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getDeck(deckHash).then(setDeck).catch(setError).finally(() => setLoading(false));
  }, [deckHash]);

  const [prevLoad, setPrevLoad] = useState(() => load);
  if (prevLoad !== load) { setPrevLoad(load); setShowAddPanel(false); }
  useEffect(() => { load(); }, [load]);

  const changed = () => { load(); onRefreshList(); };

  const removeCard = async (cardHash) => {
    try { await removeEntry(deckHash, cardHash); changed(); } catch (err) { console.error(err); }
  };

  const remove = async () => {
    const ok = await confirm({
      title: t('Delete "{name}"?', { name: deck.name }),
      message: t('This removes the deck. The cards themselves are not deleted.'),
      confirmLabel: t('Delete deck'),
      tone: 'danger',
    });
    if (!ok) return;
    try { await deleteDeck(deckHash); onDeleted(); } catch (err) { setError(err); }
  };

  const purge = async (includeShared) => {
    setPurgeBusy(true);
    setPurgeError(null);
    try {
      await purgeDeck(deckHash, includeShared);
      setPurging(false);
      onDeleted();
    } catch (err) {
      setPurgeError(err.message || t('Could not erase the deck.'));
    } finally {
      setPurgeBusy(false);
    }
  };

  const startEditMeta = () => {
    setNameVal(deck.name);
    setDescVal(deck.description ?? '');
    setEditingMeta(true);
  };

  const submitMeta = async (e) => {
    e.preventDefault();
    if (!nameVal.trim() || savingMeta) return;
    setSavingMeta(true);
    try {
      await updateDeck(deckHash, { name: nameVal.trim(), description: descVal.trim() });
      setEditingMeta(false);
      changed();
    } catch (err) {
      console.error(err);
    } finally {
      setSavingMeta(false);
    }
  };

  return {
    deck, loading, error, load, changed,
    showAddPanel, toggleAddPanel: () => setShowAddPanel((v) => !v), closeAddPanel: () => setShowAddPanel(false),
    showNewCard, setShowNewCard,
    purging, setPurging, purgeBusy, purgeError, purge, cancelPurge: () => { setPurging(false); setPurgeError(null); },
    editingMeta, setEditingMeta, nameVal, setNameVal, descVal, setDescVal, savingMeta, startEditMeta, submitMeta,
    removeCard, remove,
  };
}
