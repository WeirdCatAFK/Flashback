/**
 * The seal log, cursor-paged. Views stay mounted after their first visit, so the
 * page is refetched each time the tab becomes active — to the depth the reader
 * had reached, clamped to the server's own cap (routes/seal.js MAX_LOG_LIMIT):
 * every commit in a page costs a tree diff.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { getLog } from '../../api/seal';
import { useT } from '../../translations/index';

const PAGE_SIZE = 25;
/**
 * Matches the server's own cap (routes/seal.js MAX_LOG_LIMIT) — every commit in a page
 * costs a tree diff, so a restore-depth reload is clamped to the same ceiling.
 */
const MAX_PAGE = 200;

/**
 * Views in this app stay mounted after their first visit (see App.jsx's view-slot
 * keep-alive) — an effect with no isActive dependency would only ever fetch once,
 * then go stale on every later tab switch. Refetch each time the tab becomes active,
 * matching the convention already used by GraphView/Trainer's isActive-driven hooks.
 *
 * History is paged rather than capped: a session that produces a lot of metadata commits
 * (highlighting a PDF, say) used to push everything else past a hard 20-entry limit with
 * no way to reach it. Pages are cursor-based, so "load older" walks back arbitrarily far.
 */
export default function useSealLog(isActive) {
    const { t } = useT();
    const [log, setLog] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState(null);
    const [refreshToken, setRefreshToken] = useState(0);

    const depthRef = useRef(PAGE_SIZE);
    const logRef = useRef([]);
    useEffect(() => { logRef.current = log; }, [log]);

    useEffect(() => {
        if (!isActive) return;
        let cancelled = false;
        const size = Math.min(depthRef.current, MAX_PAGE);
        setLoading(true);
        setError(null);
        getLog({ limit: size })
            .then(page => {
                if (cancelled) return;
                setLog(page);
                setHasMore(page.length >= size);
                depthRef.current = Math.max(page.length, PAGE_SIZE);
            })
            .catch(err => { if (!cancelled) setError(err.message ?? t('Failed to load history')); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [isActive, refreshToken, t]);

    const loadMore = useCallback(() => {
        const current = logRef.current;
        const last = current[current.length - 1];
        if (!last) return;
        setLoadingMore(true);
        setError(null);
        getLog({ limit: PAGE_SIZE, cursor: last.oid })
            .then(page => {
                setLog(prev => [...prev, ...page]);
                setHasMore(page.length === PAGE_SIZE);
                depthRef.current += page.length;
            })
            .catch(err => setError(err.message ?? t('Failed to load older entries')))
            .finally(() => setLoadingMore(false));
    }, [t]);

    const refresh = useCallback(() => setRefreshToken(t => t + 1), []);

    return { log, loading, loadingMore, hasMore, error, refresh, loadMore };
}
