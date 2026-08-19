// Vault session — opening a vault, and moving between vaults without restarting.
//
// Lives beside main.js rather than under access/ on purpose: it spans config validation,
// the schema migrator, Seal and the canonical UpdateRunner, so it belongs to no single
// access tier and importing it from one would violate ACCESS.md's import rules.
//
// The whole design is one idea: `config.js`'s path resolvers are pure per-call functions
// over the active config, so switching vaults is moving a pointer. Everything here exists
// to make that safe — quiesce what is mid-flight, close what is open, then re-run the
// exact same boot sequence against the new vault.

import validate from "./config/validate.js";
import runUpdates from "./config/UpdateRunner.js";
import { sealTools, sealEmitter } from "./seal/seal.js";
import * as config from "./access/primitives/config.js";
import { closeDatabase } from "./access/primitives/database.js";
import { ensureManifest } from "./access/primitives/vault.js";
import query from "./access/resources/query.js";
import Files from "./access/resources/files.js";
import Decks from "./access/orchestration/decks.js";
import cardHealth from "./access/orchestration/cardHealth.js";
import mcpReader from "./access/orchestration/mcpReader.js";

// True while switchVault() is between tearing the old vault down and finishing the new
// one's validation. api.js reads this and answers /api/* with 503 for the duration, so no
// request can observe a half-open vault.
let switching = false;

/** @returns {boolean} whether a vault switch is in flight. */
export function isSwitching() {
    return switching;
}

/**
 * Resets the module-scope singletons that cache something vault-shaped.
 *
 * Each of these would otherwise serve the previous vault's data. They are listed
 * explicitly rather than discovered, so adding a new cache to a singleton is a visible
 * decision to add it here too.
 */
async function resetVaultScopedCaches() {
    await query.onVaultOpened();       // NodeTypes/ConnectionTypes ids — per-database autoincrements
    await cardHealth.onVaultOpened();  // session index + the vault's own median answer length
    await mcpReader.onVaultOpened();   // extraction cache keyed by relative path, no vault component
}

/**
 * Creates the directories and canonical files a vault cannot answer a request without.
 * A brand-new vault reaches here with nothing but an empty database.
 *
 * `Files` still does its work in the constructor — it only touches the filesystem, which is
 * synchronous. `Decks` cannot: it reads the schema to decide whether the system deck exists,
 * and the data layer is async now, so its setup is an awaited call rather than a constructor
 * side effect. Must run after validate(), because Decks queries the schema.
 */
async function ensureVaultDirs() {
    new Files();                          // workspace/
    await new Decks().onVaultOpened();    // workspace/_decks/ + the system deck's JSON
}

/**
 * Brings the vault config.js currently points at into a fully serviceable state.
 *
 * This is the boot sequence, extracted from main.js so that starting the process and
 * switching vaults run the same code rather than two implementations that drift. The
 * three stages and their ordering constraints are unchanged:
 *
 *   1. validate() — config, then `PRAGMA integrity_check` + schema + migrations. Rebuilds
 *      the schema from scratch for an empty database, which is exactly what a
 *      newly-created vault is. Fatal.
 *   2. Seal — must be up before stage 3, which ends in a commit.
 *   3. Canonical updates — never fatal; every read path tolerates an un-updated file, so
 *      a failure logs and the next open retries rather than locking the user out.
 *
 * @param {{onFatal?: (msg: string) => void}} [options]
 * @returns {Promise<boolean>} false when validation failed and the vault is unusable.
 */
export async function openVault({ onFatal } = {}) {
    if (!await validate()) {
        onFatal?.("Validation failed.");
        return false;
    }

    ensureManifest();
    await resetVaultScopedCaches();

    await sealTools.init();
    console.log("Seal initialized.");

    try {
        const r = await runUpdates();
        if (r.walked) {
            console.log(
                `Canonical updates ${r.pending.join(", ") || "(re-check)"}: ` +
                `${r.documents} document(s), ${r.folders} folder(s), ${r.decks} deck file(s)` +
                (r.derivedRows ? `, ${r.derivedRows} derived row(s)` : "") +
                (r.sealedOid ? ` — sealed ${r.sealedOid.slice(0, 8)}` : "")
            );
            for (const w of r.warnings) console.warn(`Canonical update warning: ${w}`);
            if (!r.recorded) console.warn("Canonical updates incomplete — will run again next launch.");
        }
    } catch (err) {
        console.error("Canonical updates failed (continuing; will retry next launch):", err?.stack || err);
    }

    await ensureVaultDirs();
    return true;
}

/**
 * Switches the API to a different local vault, in process.
 *
 * The ordering is the entire safety argument, so it is worth reading as a sequence rather
 * than a list of steps:
 *
 *   1. Quiesce Seal FIRST. Its 2-second edit debounce resolves the repo directory and the
 *      commit author when it fires, not when it was armed — a timer left running would
 *      stage the old vault's sidecar paths into the new vault's git repo. Flushing rather
 *      than cancelling means those edits land in the vault they belong to.
 *   2. Close the database, checkpointing the WAL, so the old vault is left consistent on
 *      disk and its files are free for a rename.
 *   3. Move the pointer. Nothing has re-derived a path yet.
 *   4. Re-open. Everything downstream resolves against the new vault from here.
 *
 * `switching` is raised across the whole sequence and lowered in a finally, so a failure
 * part-way cannot wedge the API into permanent 503s.
 *
 * @param {{id: string, name: string, isCustomPath?: boolean, customPath?: string}} entry
 * @returns {Promise<{ok: true, vault: object}|{ok: false, error: string}>}
 */
export async function switchVault(entry) {
    if (!entry?.name) return { ok: false, error: "A vault entry with a name is required." };
    if (switching) return { ok: false, error: "A vault switch is already in progress." };

    switching = true;
    try {
        await sealEmitter.quiesce();
        closeDatabase();

        if (!config.setActiveVault(entry)) {
            return { ok: false, error: "Could not write the active vault to config.json." };
        }
        config.reload();

        let fatal = null;
        const ok = await openVault({ onFatal: (msg) => { fatal = msg; } });
        if (!ok) return { ok: false, error: fatal ?? "The vault could not be opened." };

        return { ok: true, vault: ensureManifest() };
    } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
    } finally {
        switching = false;
    }
}

/**
 * Releases the active vault without opening another — used before the Electron host
 * renames a vault's folder on disk, since Windows will not rename a directory holding an
 * open file handle. The next database access re-opens lazily through the Proxy in
 * database.js, so there is no matching "resume".
 *
 * @returns {Promise<void>}
 */
export async function releaseVault() {
    await sealEmitter.quiesce();
    closeDatabase();
}
