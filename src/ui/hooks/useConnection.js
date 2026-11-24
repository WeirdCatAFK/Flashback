import { useCallback, useEffect, useState } from 'react';
import { initClient, getConnectionId } from '../api/client.js';
import { setActiveVaultScope } from '../utils/prefs.js';

const FALLBACK = { kind: 'local', id: null, label: null, url: 'http://localhost:50500', token: null };

export default function useConnection() {
    const [connection, setConnection] = useState(null);
    const [connectionId, setConnectionId] = useState(() => getConnectionId());

    const apply = useCallback((next) => {
        if (!next?.url) return;
        initClient(next.url, next.token ?? null);
        setActiveVaultScope(next.id ?? null);
        setConnection(next);
        setConnectionId(getConnectionId());
    }, []);

    useEffect(() => {
        if (!window.flashback?.getActiveConnection) {
            setConnection(FALLBACK);
            return;
        }
        let cancelled = false;
        window.flashback.getActiveConnection().then((c) => {
            if (!cancelled && c) setConnection(c);
        });
        const off = window.flashback.onConnectionChange?.((next) => apply(next));
        return () => { cancelled = true; off?.(); };
    }, [apply]);

    const useLocal = useCallback(async () => {
        const result = await window.flashback?.useLocalVault?.();
        if (result?.connection) apply(result.connection);
        return result;
    }, [apply]);

    const useRemote = useCallback(async (id) => {
        const result = await window.flashback?.useRemote?.(id);
        if (result?.ok && result.connection) apply(result.connection);
        return result;
    }, [apply]);

    return { connection, connectionId, ready: !!connection, useLocal, useRemote };
}
