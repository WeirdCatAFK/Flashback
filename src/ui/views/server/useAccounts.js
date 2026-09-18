/**
 * The server's people: the account list with who you are and the seat limit,
 * and `run`, which wraps every mutation so the list is refreshed and an error
 * lands in one place.
 */

import { useState, useEffect, useCallback } from 'react';
import { listAccounts } from '../../api/accounts';

export default function useAccounts() {
  const [accounts, setAccounts] = useState([]);
  const [you, setYou] = useState(null);
  const [limit, setLimit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listAccounts();
      setAccounts(data.accounts ?? []);
      setYou(data.you ?? null);
      setLimit(Number.isInteger(data.limit) ? data.limit : null);
      setError(null);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = async (key, fn) => {
    setBusy(key);
    try { await fn(); setError(null); } catch (e) { setError(e.message || String(e)); } finally { setBusy(null); await refresh(); }
  };

  const activeCount = accounts.filter((a) => a.active).length;
  return { accounts, you, limit, loading, error, busy, run, activeCount, full: limit != null && activeCount >= limit };
}
