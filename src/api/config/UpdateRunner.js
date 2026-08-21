/**
 * Runs pending updates against the CANONICAL layer — the `.flashback` sidecars and
 * `_decks/*.json` files that are the vault's source of truth.
 *
 * This is the document-driven counterpart of `MigrationRunner.js`, and the two are
 * deliberately shaped alike: numbered modules, applied in order, recorded once applied.
 * They cannot be the same mechanism, because a migration gets nothing but a database handle
 * inside a transaction, while these do file IO and end in a Seal commit.
 *
 * Where they differ is the version marker, and the difference is the point:
 *
 *   - `SchemaVersion` records the version of the ONE database.
 *   - `CanonicalVersion` records which updates this vault has finished, but the authority is
 *     the `formatVersion` stamped on EVERY canonical file. Each item says what it is, so a
 *     file that arrives from a backup, another machine, or a Seal rollback to a year-old
 *     commit is still self-describing, and the runner can bring it forward on its own.
 *
 * `CanonicalVersion` is therefore an optimisation, not the source of truth: it is what lets
 * startup skip the walk entirely when there is nothing to do. Correctness comes from the
 * per-item stamps plus the rule that **every update must be idempotent per item** — see
 * `updates/UPDATES.md`.
 *
 * Failure is per item. A file that cannot be parsed or that throws is left exactly as found
 * and reported as a warning; the vault-level record is then NOT written, so the next launch
 * tries again. One bad file can never block the rest of a vault, and can never be
 * half-written.
 */

import Files from '../access/resources/files.js';
import Decks from '../access/orchestration/decks.js';
import query from '../access/resources/query.js';
import { sealTools } from '../seal/seal.js';
import { UPDATES, LATEST_VERSION, pendingFor } from './updates/registry.js';

export { LATEST_VERSION };

/**
 * Applies every pending update to one canonical file object and stamps it.
 *
 * @returns {{ changed: boolean, applied: number[] }} `changed` covers the stamp too, so an
 *   item that needed no transform still gets rewritten once to record where it stands.
 */
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

/**
 * Runs the canonical updates over the whole vault.
 *
 * @param {object}  [options]
 * @param {Array}   [options.updates]  update modules to run (injectable for tests).
 * @param {boolean} [options.force]    walk even when the vault record says there is nothing
 *                                     pending — the repair path for files restored behind
 *                                     the runner's back.
 * @param {boolean} [options.seal]     commit the rewrite (off in tests that have no repo).
 * @returns {Promise<{ pending: number[], walked: boolean, documents: number, folders: number,
 *                     decks: number, warnings: string[], sealedOid: string|null,
 *                     derivedRows: number, recorded: boolean }>}
 */
export default async function runUpdates({ updates = UPDATES, force = false, seal = true } = {}) {
    const target = updates.reduce((max, u) => Math.max(max, u.version), 0);
    const applied = await query.getCanonicalVersions();
    const pending = updates.filter(u => !applied.has(u.version)).map(u => u.version).sort((a, b) => a - b);

    const result = {
        pending, walked: false, documents: 0, folders: 0, decks: 0,
        warnings: [], sealedOid: null, derivedRows: 0, recorded: false,
    };

    // The steady state: one indexed read, no file IO at all. The walk below only happens
    // when a new version of the app ships an update, or a caller asks for the repair path.
    if (pending.length === 0 && !force) return result;

    result.walked = true;
    const files = new Files();
    const decks = new Decks();
    // The walk below reads `_decks/*.json`, and the system deck's file is created lazily.
    // It used to be materialized as a side effect of `new Decks()`; that check reads the
    // schema, so it moved to an awaited call when the data layer became async. Without
    // this the deck pass silently walks nothing on a vault whose system deck has never
    // been written.
    await decks.onVaultOpened();

    const walk = files.walkWorkspace();

    for (const doc of walk.documents) {
        if (doc.sidecarCorrupt || !doc.meta) {
            result.warnings.push(`Unreadable sidecar, left untouched: ${doc.relPath}`);
            continue;
        }
        try {
            const { changed } = upgradeItem(doc.meta, 'document', updates, target);
            if (changed) {
                files.writeMetadata(doc.relPath, doc.meta, false);
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
                files.writeMetadata(folder.relPath, folder.meta, true);
                result.folders++;
            }
        } catch (err) {
            result.warnings.push(`Update failed for ${folder.relPath}: ${err.message}`);
        }
    }

    // Standalone cards live in _decks/*.json, whose IO stays inside the Decks module.
    const deckResult = await decks.mapDeckFiles((file) => upgradeItem(file, 'deck', updates, target).changed);
    result.decks = deckResult.filesRewritten;
    for (const hash of deckResult.corruptFiles) {
        result.warnings.push(`Unreadable deck file, left untouched: _decks/${hash}.json`);
    }
    for (const { hash, error } of deckResult.failed) {
        result.warnings.push(`Update failed for _decks/${hash}.json: ${error}`);
    }

    // Each update's optional derived-layer fix-up. Idempotent by contract, so running it
    // after a partially-skipped pass is safe.
    for (const update of updates) {
        if (typeof update.derived !== 'function') continue;
        try {
            // Awaited: a derived fix-up reads and writes the index, so it is async now.
            // Without the await this adds a Promise to a number and reports NaN rows.
            result.derivedRows += await update.derived(query) ?? 0;
        } catch (err) {
            result.warnings.push(`Derived fix-up failed for update ${update.version}: ${err.message}`);
        }
    }

    // One `reconcile:` commit for the whole pass — the upgrade is one event in the vault's
    // history, not one commit per file.
    if (seal && (result.documents || result.folders || result.decks)) {
        result.sealedOid = await sealTools.commitDrift();
    }

    // Only claim the vault is done when every item actually got there. A skipped file means
    // the next launch walks again and picks it up.
    if (result.warnings.length === 0) {
        for (const update of updates) {
            if (!applied.has(update.version)) await query.recordCanonicalVersion(update.version, update.description);
        }
        result.recorded = true;
    }

    return result;
}
