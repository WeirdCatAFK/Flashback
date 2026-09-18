/**
 * Which place the renderer is pointed at — the local vault or a remote server —
 * read from Electron main and re-initialising the API client on every change.
 */

import { useCallback, useEffect, useState } from 'react';
import { initClient, getConnectionId } from '../api/client.js';

const FALLBACK = { kind: 'local', id: null, label: null, url: 'http://localhost:50500', token: null };

/**
 * Reads the active connection from the Electron host and re-points the API client
 * whenever it changes.
 *
 * @returns {{connection: object|null, connectionId: number, ready: boolean,
 *            useLocal: () => Promise<void>, useRemote: (id: string) => Promise<object>}}
 */
export default function useConnection() {
    const [connection, setConnection] = useState(null);
    const [connectionId, setConnectionId] = useState(() => getConnectionId());

    const apply = useCallback((next) => {
        if (!next?.url) return;
        initClient(next.url, next.token ?? null);
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
