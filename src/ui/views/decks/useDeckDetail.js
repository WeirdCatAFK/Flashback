/**
 * One deck as its page sees it: its record (with each card's gap for you), and
 * every change the page offers — rename, describe, recolour the box, change the
 * cover (DeckCover does the talking to the API; this keeps the record), remove a card,
 * delete (confirmed in place), erase (with the shared-card choice). A deck made a
 * moment ago opens with its name ready to type, and the add-cards layer opens once
 * the name is settled — not together, since both want the keyboard.
 */

import { useState, useEffect, useCallback } from 'react';
import { getDeck, updateDeck, deleteDeck, purgeDeck, removeEntry } from '../../api/decks';
import { getPref } from '../../prefs.js';
import { useT } from '../../translations/index';

export default function useDeckDetail({ deckHash, version, fresh, onDeleted, onRefreshList }) {
  const { t } = useT();
  const [deck, setDeck] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [purging, setPurging] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeError, setPurgeError] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(fresh);
  const [editingDesc, setEditingDesc] = useState(false);

  const load = useCallback(() => {
    setError(null);
    return getDeck(deckHash, getPref('fb-srs-algorithm') ?? 'sm2')
      .then(setDeck)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [deckHash]);

  useEffect(() => { load(); }, [load, version]);

  const changed = () => { load(); onRefreshList(); };

  const guard = async (fn) => {
    setActionError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setActionError(err.message ?? String(err));
      return false;
    }
  };

  const removeCard = (cardHash) => guard(async () => { await removeEntry(deckHash, cardHash); changed(); });

  const rename = async (name) => {
    setRenaming(false);
    if (fresh && !deck.entries?.length) setShowAddPanel(true);
    const next = name.trim();
    if (!next || next === deck.name) return;
    setDeck((d) => ({ ...d, name: next }));
    await guard(async () => { await updateDeck(deckHash, { name: next }); changed(); });
  };

  const describe = async (description) => {
    setEditingDesc(false);
    const next = description.trim();
    if (next === (deck.description ?? '')) return;
    setDeck((d) => ({ ...d, description: next }));
    await guard(async () => { await updateDeck(deckHash, { description: next }); changed(); });
  };

  const recolor = async (color) => {
    if (color === deck.color) return;
    const before = deck.color;
    setDeck((d) => ({ ...d, color }));
    const ok = await guard(async () => { await updateDeck(deckHash, { color }); onRefreshList(); });
    if (!ok) setDeck((d) => ({ ...d, color: before }));
  };

  const remove = async () => {
    setDeleting(true);
    const ok = await guard(() => deleteDeck(deckHash));
    setDeleting(false);
    if (ok) onDeleted(deck.name);
  };

  const purge = async (includeShared) => {
    setPurgeBusy(true);
    setPurgeError(null);
    try {
      await purgeDeck(deckHash, includeShared);
      setPurging(false);
      onDeleted(deck.name);
    } catch (err) {
      setPurgeError(err.message || t('Could not erase the deck.'));
    } finally {
      setPurgeBusy(false);
    }
  };

  return {
    deck, loading, error, actionError, load, changed,
    showAddPanel, toggleAddPanel: () => setShowAddPanel((v) => !v), closeAddPanel: () => setShowAddPanel(false),
    purging, setPurging, purgeBusy, purgeError, purge, cancelPurge: () => { setPurging(false); setPurgeError(null); },
    confirmingDelete, setConfirmingDelete, deleting, remove,
    renaming, setRenaming, rename,
    editingDesc, setEditingDesc, describe,
    recolor, removeCard,
    setCover: (cover) => setDeck((d) => ({ ...d, cover })),
  };
}
