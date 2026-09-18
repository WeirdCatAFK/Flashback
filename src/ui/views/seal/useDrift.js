/**
 * Loose pages: what changed in the workspace outside Flashback, refetched each
 * time the tab becomes active.
 */

import { useState, useEffect, useCallback } from 'react';
import { inspectDrift } from '../../api/seal';
import { useT } from '../../translations/index';

export default function useDrift(isActive) {
    const { t } = useT();
    const [drift, setDrift] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [refreshToken, setRefreshToken] = useState(0);

    useEffect(() => {
        if (!isActive) return;
        setLoading(true);
        setError(null);
        inspectDrift()
            .then(setDrift)
            .catch(err => setError(err.message ?? t('Failed to inspect workspace')))
            .finally(() => setLoading(false));
    }, [isActive, refreshToken, t]);

    const refresh = useCallback(() => setRefreshToken(t => t + 1), []);

    return { drift, loading, error, refresh };
}
