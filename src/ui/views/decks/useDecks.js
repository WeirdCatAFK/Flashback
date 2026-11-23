import { useState, useEffect, useCallback } from 'react';
import { listDecks } from '../../api/decks';
import { getPref } from '../../utils/prefs.js';
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
