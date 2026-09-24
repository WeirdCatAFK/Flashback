/**
 * The deck list, default deck first, each with its colour and how its cards stand
 * for you — refetched on demand, on any data change, and when the screen comes
 * back into view (a study session elsewhere changes what is due).
 */

import { useState, useEffect, useCallback } from 'react';
import { listDecks } from '../../api/decks';
import { getPref } from '../../prefs.js';
import { useDataInvalidation } from '../../utils/dataBus';
import { sortDecks } from './deckShelf.js';

export default function useDecks({ isActive = true } = {}) {
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => {
    setError(null);
    listDecks(getPref('fb-srs-algorithm') ?? 'sm2')
      .then((list) => setDecks(sortDecks(list)))
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (isActive) refresh(); }, [refresh, isActive]);
  useDataInvalidation(() => { refresh(); setVersion((v) => v + 1); });

  return { decks, loading, error, refresh, version };
}
