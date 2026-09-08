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

let switching = false;

/** @returns {boolean} whether a vault switch is in flight. */
export function isSwitching() {
    return switching;
}

/** Resets the module-scope singletons that cache something vault-shaped. */
async function resetVaultScopedCaches() {
    await query.onVaultOpened();
    await cardHealth.onVaultOpened();
    await mcpReader.onVaultOpened();
}

/** Creates the directories and canonical files a vault cannot answer a request without. */
async function ensureVaultDirs() {
    new Files();
    await new Decks().onVaultOpened();
}

/**
 * Brings the vault config.js currently points at into a fully serviceable state.
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
 * Releases the active vault without opening another — used before the Electron host renames a vault's folder on disk, since Windows will not rename a…
 *
 * @returns {Promise<void>}
 */
export async function releaseVault() {
    await sealEmitter.quiesce();
    closeDatabase();
}
