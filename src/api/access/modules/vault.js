import * as vaultRows from '../resources/db/vault.js';

/** shortcut: canonicalVersion repeats formatVersion for remotes on older builds. Remove it one release after 2026-11. */
export async function versions() {
    const formatVersion = Math.max(0, ...await vaultRows.getFormatVersions(), 0);
    return {
        schemaVersion: await vaultRows.getSchemaVersion(),
        formatVersion,
        canonicalVersion: formatVersion,
    };
}
