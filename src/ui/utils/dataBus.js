import { useEffect, useRef } from 'react';

const DATA_INVALIDATED = 'flashback:data-invalidated';

export function invalidateData() {
    window.dispatchEvent(new Event(DATA_INVALIDATED));
}

export function useDataInvalidation(callback) {
    const ref = useRef(callback);
    ref.current = callback;
    useEffect(() => {
        const handler = () => ref.current?.();
        window.addEventListener(DATA_INVALIDATED, handler);
        return () => window.removeEventListener(DATA_INVALIDATED, handler);
    }, []);
}
