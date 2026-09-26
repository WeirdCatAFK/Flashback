/**
 * The statistics for the caller, or for another account when an admin is
 * viewing someone else's progress, reloaded each time the tab becomes active.
 */

import { useState, useEffect, useCallback } from 'react';
import { getStatistics } from '../../api/srs';
import { getAccountProgress } from '../../api/accounts';
import { getPref } from '../../prefs.js';

export default function useStats(isActive, viewingId = null) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(() => {
    const algorithm = getPref('fb-srs-algorithm') ?? 'sm2';
    setLoading(true);
    const load = viewingId ? getAccountProgress(viewingId, algorithm).then((d) => d.statistics) : getStatistics(algorithm);
    load
      .then((s) => { setStats(s); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [viewingId]);

  useEffect(() => { if (isActive) reload(); }, [isActive, reload]);

  return { stats, loading, error, reload, firstLoad: loading && !stats };
}
