/** Going to a local vault is one operation, useLocalVault(). switch-vault must call it, or a dead remote leaves no way back. */
export function createConnectionState({ readConfig, connectionForRemote, apiBaseUrl }) {
    let activeRemoteId = null;

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
        current() {
            if (activeRemoteId) {
                const remote = connectionForRemote(activeRemoteId);
                if (remote) return remote;
                activeRemoteId = null;
            }
            return localConnection();
        },

        useRemote(id) {
            activeRemoteId = id;
            return this.current();
        },

        useLocalVault() {
            activeRemoteId = null;
            return this.current();
        },

        get remoteId() {
            return activeRemoteId;
        },
    };
}
