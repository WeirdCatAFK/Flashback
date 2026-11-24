import validate from "./config/validate.js";
import runUpdates from "./config/UpdateRunner.js";
import { sealTools, sealEmitter } from "./seal/seal.js";
import * as config from "./access/primitives/config.js";
import { closeDatabase } from "./access/primitives/database.js";
import { ensureManifest } from "./access/primitives/vault.js";
import * as nodeRows from './access/resources/db/nodes.js';
import * as Files from './access/resources/files.js';
import * as Decks from './access/modules/decks.js';
import * as CardHealth from './access/modules/cardHealth.js';
import * as McpReader from './access/modules/mcpReader.js';
import * as Highlights from './access/modules/highlights.js';
import * as Diary from './access/modules/diary.js';
import * as Categories from './access/modules/categories.js';
import storage from "./access/primitives/storage.js";

let switching = false;

export function isSwitching() {
    return switching;
}

async function resetVaultScopedCaches() {
    await nodeRows.onVaultOpened();
    await CardHealth.onVaultOpened();
    await McpReader.onVaultOpened();
    storage.onVaultOpened();
}

async function ensureVaultDirs() {
    Files.ensureRoot();
    await Decks.onVaultOpened();
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
                `Format updates ${r.pending.join(", ") || "(re-check)"}: ` +
                `${r.documents} document(s), ${r.folders} folder(s), ${r.decks} deck file(s)` +
                (r.derivedRows ? `, ${r.derivedRows} derived row(s)` : "") +
                (r.sealedOid ? ` — sealed ${r.sealedOid.slice(0, 8)}` : "")
            );
            for (const w of r.warnings) console.warn(`Format update warning: ${w}`);
            if (!r.recorded) console.warn("Format updates incomplete — will run again next launch.");
        }
    } catch (err) {
        console.error("Format updates failed (continuing; will retry next launch):", err?.stack || err);
    }

    try {
        const moved = await Diary.adoptLegacyFolder();
        if (moved) console.log(`Moved ${moved} diary entr${moved === 1 ? "y" : "ies"} into the portable files.`);
    } catch (err) {
        console.error("Diary move failed (continuing; will retry next launch):", err?.stack || err);
    }

    try {
        if (await Categories.exportIfMissing()) console.log("Wrote the categories to _categories.json.");
    } catch (err) {
        console.error("Category export failed (continuing; will retry next launch):", err?.stack || err);
    }

    try {
        const filled = await Highlights.backfillCardAnchors();
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
