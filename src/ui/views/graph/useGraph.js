/**
 * Fetches and builds the graph for the caller, or for another account when an
 * admin is viewing someone else's progress (same shape, different route).
 */

import { useState, useEffect, useCallback } from 'react';
import { getGraph } from '../../api/documents';
import { getAccountGraph } from '../../api/accounts';
import { buildGraphData } from './graphData.js';

export default function useGraph(isActive, viewingId = null) {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const [prevIsActive, setPrevIsActive] = useState(isActive);
  if (prevIsActive !== isActive) {
    setPrevIsActive(isActive);
    if (isActive) setLoading(true);
  }

  useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    setLoading(true);
    const load = viewingId ? getAccountGraph(viewingId) : getGraph();
    load
      .then((data) => { if (!cancelled) { setGraphData(buildGraphData(data)); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [isActive, refreshToken, viewingId]);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);
  return { graphData, loading, error, refresh };
}
