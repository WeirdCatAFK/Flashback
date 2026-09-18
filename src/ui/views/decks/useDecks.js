/**
 * The deck list, system deck first, refetched on demand and on any data change.
 */

import { useState, useEffect, useCallback } from 'react';
import { listDecks } from '../../api/decks';
import { useDataInvalidation } from '../../utils/dataBus';

/** System deck first, then the API's order. */
export const sortDecks = (list) => [...list].sort((a, b) => (b.is_system ? 1 : 0) - (a.is_system ? 1 : 0));

export default function useDecks() {
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    listDecks()
      .then((list) => setDecks(sortDecks(list)))
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useDataInvalidation(() => { refresh(); setVersion((v) => v + 1); });

  return { decks, loading, error, refresh, version };
}
