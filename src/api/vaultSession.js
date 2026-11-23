import validate from "./config/validate.js";
import runUpdates from "./config/UpdateRunner.js";
import { sealTools, sealEmitter } from "./seal/seal.js";
import * as config from "./access/primitives/config.js";
import { closeDatabase } from "./access/primitives/database.js";
import { ensureManifest } from "./access/primitives/vault.js";
import * as nodeRows from './access/resources/db/nodes.js';
import Files from "./access/resources/files.js";
import Decks from "./access/modules/decks.js";
import cardHealth from "./access/modules/cardHealth.js";
import mcpReader from "./access/modules/mcpReader.js";
import highlights from "./access/modules/highlights.js";
import storage from "./access/primitives/storage.js";

let switching = false;

export function isSwitching() {
    return switching;
}

async function resetVaultScopedCaches() {
    await nodeRows.onVaultOpened();
    await cardHealth.onVaultOpened();
    await mcpReader.onVaultOpened();
    storage.onVaultOpened();
}

async function ensureVaultDirs() {
    new Files();
    await new Decks().onVaultOpened();
}

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

    try {
        const filled = await highlights.backfillCardAnchors();
        if (filled) console.log(`Recorded the source highlight of ${filled} card(s) in the index.`);
    } catch (err) {
        console.error("Card highlight backfill failed (continuing; will retry next launch):", err?.stack || err);
    }

    await ensureVaultDirs();
    return true;
}

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

export async function releaseVault() {
    await sealEmitter.quiesce();
    closeDatabase();
}
