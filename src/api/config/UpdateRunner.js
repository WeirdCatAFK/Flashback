import * as Files from '../access/resources/files.js';
import * as Decks from '../access/modules/decks.js';
import * as vaultRows from '../access/resources/db/vault.js';
import { sealTools } from '../seal/seal.js';
import { UPDATES, LATEST_VERSION, pendingFor } from './updates/registry.js';

export { LATEST_VERSION };

function upgradeItem(meta, kind, updates, target) {
    const from = Number.isInteger(meta.formatVersion) ? meta.formatVersion : 0;
    const applied = [];
    let changed = false;

    for (const update of pendingFor(from, updates)) {
        if (update.up(meta, kind) === true) changed = true;
        applied.push(update.version);
    }

    if (from !== target) {
        meta.formatVersion = target;
        changed = true;
    }

    return { changed, applied };
}

export default async function runUpdates({ updates = UPDATES, force = false, seal = true } = {}) {
    const target = updates.reduce((max, u) => Math.max(max, u.version), 0);
    const applied = await vaultRows.getFormatVersions();
    const pending = updates.filter(u => !applied.has(u.version)).map(u => u.version).sort((a, b) => a - b);

    const result = {
        pending, walked: false, documents: 0, folders: 0, decks: 0,
        warnings: [], sealedOid: null, derivedRows: 0, recorded: false,
    };

    if (pending.length === 0 && !force) return result;

    result.walked = true;
    await Decks.onVaultOpened();

    const walk = Files.walkWorkspace();

    for (const doc of walk.documents) {
        if (doc.sidecarCorrupt || !doc.meta) {
            result.warnings.push(`Unreadable sidecar, left untouched: ${doc.relPath}`);
            continue;
        }
        try {
            const { changed } = upgradeItem(doc.meta, 'document', updates, target);
            if (changed) {
                Files.writeMetadata(doc.relPath, doc.meta, false);
                result.documents++;
            }
        } catch (err) {
            result.warnings.push(`Update failed for ${doc.relPath}: ${err.message}`);
        }
    }

    for (const folder of walk.folders) {
        if (folder.sidecarCorrupt || !folder.meta) {
            if (folder.sidecarExists) result.warnings.push(`Unreadable folder sidecar, left untouched: ${folder.relPath}`);
            continue;
        }
        try {
            const { changed } = upgradeItem(folder.meta, 'folder', updates, target);
            if (changed) {
                Files.writeMetadata(folder.relPath, folder.meta, true);
                result.folders++;
            }
        } catch (err) {
            result.warnings.push(`Update failed for ${folder.relPath}: ${err.message}`);
        }
    }

    const deckResult = await Decks.mapDeckFiles((file) => upgradeItem(file, 'deck', updates, target).changed);
    result.decks = deckResult.filesRewritten;
    for (const hash of deckResult.corruptFiles) {
        result.warnings.push(`Unreadable deck file, left untouched: _decks/${hash}.json`);
    }
    for (const { hash, error } of deckResult.failed) {
        result.warnings.push(`Update failed for _decks/${hash}.json: ${error}`);
    }

    for (const update of updates) {
        if (typeof update.derived !== 'function') continue;
        try {
            result.derivedRows += await update.derived() ?? 0;
        } catch (err) {
            result.warnings.push(`Derived fix-up failed for update ${update.version}: ${err.message}`);
        }
    }

    if (seal && (result.documents || result.folders || result.decks)) {
        result.sealedOid = await sealTools.commitDrift();
    }

    if (result.warnings.length === 0) {
        for (const update of updates) {
            if (!applied.has(update.version)) await vaultRows.recordFormatVersion(update.version, update.description);
        }
        result.recorded = true;
    }

    return result;
}
