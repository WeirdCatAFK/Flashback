/**
 * Which place the renderer is pointed at: the local API serving a local vault, or a remote
 * Flashback Server. One flag, `activeRemoteId`, decides — null means local.
 *
 * ## Why this is its own module
 *
 * It used to be a bare `let` beside the IPC handlers in `main.js`, and the bug that produced
 * is the reason for the shape below. Three handlers move the app between places:
 *
 *   use-remote       → point at a remote
 *   use-local-vault  → point back at the local API
 *   switch-vault     → tell the local API to open a DIFFERENT local vault
 *
 * The first two set and cleared the flag. The third did not — and `switch-vault` is what BOTH
 * the title-bar switcher and the vault manager call when you click a local vault, because
 * their "already active, just re-point" branch is unreachable while you are on a remote. So
 * choosing a local vault switched the local API's database and then reported the remote
 * again: the connection broadcast carried the same remote the renderer was already on,
 * nothing re-pointed, and the only way off a misconfigured server was to restart the app.
 *
 * The fix is not a fourth assignment scattered among the handlers. It is that **going to a
 * local vault is one operation** — `useLocalVault()` — and `switch-vault` performs it after
 * the API confirms the switch. `connectionForRemote` reads the registry and never the
 * network, so an unreachable remote resolves forever; nothing times out and drops you home,
 * which is exactly why the deliberate route back must always work.
 *
 * Dependencies are injected rather than imported so this file pulls in no Electron at all
 * and `tests/connection.test.js` can run it under plain Node, like `sequencing.js`.
 */

/**
 * @param {object} deps
 * @param {() => object} deps.readConfig            current config.json
 * @param {(id: string) => object|null} deps.connectionForRemote  registry lookup, no network
 * @param {(config: object) => string} deps.apiBaseUrl            local API base URL
 */
export function createConnectionState({ readConfig, connectionForRemote, apiBaseUrl }) {
    // null = the local vault. Set to a remote's id while the user is working on a remote.
    let activeRemoteId = null;

    /** The local API and whichever vault it currently has open. */
    function localConnection() {
        const config = readConfig();
        const active = (config.vaults ?? []).find((v) => v.id === config.activeVaultId);
        return {
            kind: 'local',
            id: config.activeVaultId ?? null,
            label: active?.name ?? config.vaultName ?? null,
            url: apiBaseUrl(config),
            token: config.apiToken ?? null,
        };
    }

    return {
        /**
         * Where the renderer should point right now.
         *
         * A remote that has disappeared from the registry falls back to local and clears the
         * flag — the app must not be pointed at a place that no longer exists. An unreachable
         * one does NOT, because reachability is not knowable from here and a server that is
         * merely restarting is not a server you have left.
         */
        current() {
            if (activeRemoteId) {
                const remote = connectionForRemote(activeRemoteId);
                if (remote) return remote;
                activeRemoteId = null;   // the remote was removed underneath us
            }
            return localConnection();
        },

        /** Point at a remote. The caller handshakes first; this only records the choice. */
        useRemote(id) {
            activeRemoteId = id;
            return this.current();
        },

        /**
         * Point back at the local API. Idempotent, and the ONLY way the flag is cleared by
         * intent — every path that lands the user on a local vault goes through here, so a
         * new one cannot forget to.
         */
        useLocalVault() {
            activeRemoteId = null;
            return this.current();
        },

        /** For assertions and diagnostics; not part of the connection contract. */
        get remoteId() {
            return activeRemoteId;
        },
    };
}
