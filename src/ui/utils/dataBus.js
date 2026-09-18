/**
 * A window-level "data changed" broadcast: fire it after an import, a rollback
 * or a bulk edit, and every view that subscribes refetches.
 */

import { useEffect, useRef } from 'react';

const DATA_INVALIDATED = 'flashback:data-invalidated';

export function invalidateData() {
    window.dispatchEvent(new Event(DATA_INVALIDATED));
}

/**
 * Subscribe a component to data-invalidation events. The callback is held in a
 * ref so the listener is registered once and always calls the latest closure —
 * callers don't need to memoize what they pass in.
 */
export function useDataInvalidation(callback) {
    const ref = useRef(callback);
    ref.current = callback;
    useEffect(() => {
        const handler = () => ref.current?.();
        window.addEventListener(DATA_INVALIDATED, handler);
        return () => window.removeEventListener(DATA_INVALIDATED, handler);
    }, []);
}
