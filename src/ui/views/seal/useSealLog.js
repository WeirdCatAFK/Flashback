import { useState, useEffect, useCallback, useRef } from 'react';
import { getLog } from '../../api/seal';
import { useT } from '../../translations/index';

const PAGE_SIZE = 25;
const MAX_PAGE = 200;

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
