import { useCallback, useEffect, useState } from 'react';
import { initClient, getConnectionId } from '../api/client.js';

// The active connection: either the local API serving a local vault, or a remote
// Flashback Server. Both are a {url, token} pair, which is the whole reason switching
// between a local vault and a remote is one mechanism rather than two.
//
// Switching to a remote does NOT stop the local API — it keeps running, idle, serving the
// local vault to the MCP server. Switching between two LOCAL vaults is the heavier case:
// the API process closes one database and opens another, which is why the app has to wait
// for it to come back (App.jsx remounts AppGate, which re-polls).

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
    // Seeded from the client's own counter so the first render already matches whatever
    // index.jsx initialised before React mounted — no spurious remount on startup.
    const [connectionId, setConnectionId] = useState(() => getConnectionId());

    const apply = useCallback((next) => {
        if (!next?.url) return;
        initClient(next.url, next.token ?? null);
        setConnection(next);
        setConnectionId(getConnectionId());
    }, []);

    useEffect(() => {
        if (!window.flashback?.getActiveConnection) {
            // Browser-only dev fallback (npm run dev:web): no IPC, one fixed connection.
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
        // Only repoint on success — a failed handshake must leave the app on the vault it
        // is already showing rather than on a server that did not answer.
        if (result?.ok && result.connection) apply(result.connection);
        return result;
    }, [apply]);

    return { connection, connectionId, ready: !!connection, useLocal, useRemote };
}
