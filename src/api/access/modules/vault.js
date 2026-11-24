import * as vaultRows from '../resources/db/vault.js';

export async function versions() {
    return {
        schemaVersion: await vaultRows.getSchemaVersion(),
        canonicalVersion: Math.max(0, ...await vaultRows.getCanonicalVersions(), 0),
    };
}
