// Tier 1 — vault identity.
//
// Every vault carries a `vault.json` manifest at its root giving it a stable UUID that
// survives renames, moves and copies of the folder. The derived database can be rebuilt
// from the canonical layer at any time and `vaultName` is just a folder name the user is
// free to change, so neither is an identity — this file is.
//
// It lives at the vault root, a SIBLING of `workspace/` rather than inside it, for the
// same reason the database does: `workspace/` is the Seal git repo, and a vault's identity
// is not something to version, roll back, or carry into a diff. Keeping it out also means
// `UpdateRunner`'s workspace walk never sees it and it needs no `formatVersion`.
//
// Imports `config` only, per the Tier 1 rules in ACCESS.md.

import path from "path";
import fs from "fs";
import crypto from "crypto";
import { getVaultPath, get as getConfig } from "./config.js";

// Bumped only if the manifest's own shape changes. Unrelated to the sidecar
// `formatVersion` ladder in config/updates/ — nothing here is canonical user data.
export const MANIFEST_VERSION = 1;

const MANIFEST_NAME = "vault.json";

function manifestPath() {
    return path.join(getVaultPath(), MANIFEST_NAME);
}

/**
 * Reads the active vault's manifest.
 * @returns {{id: string, name: string, createdAt: string, manifestVersion: number}|null}
 *          null when the file is missing or unreadable — callers treat that as
 *          "not stamped yet" and call ensureManifest().
 */
export function readManifest() {
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath(), "utf-8"));
        return typeof parsed?.id === "string" && parsed.id ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Stamps the active vault with a manifest if it does not already have one.
 *
 * Idempotent: an existing manifest is returned untouched, so this is safe to call on
 * every boot and every vault switch. That is how vaults created before this existed
 * acquire an id — on their next launch, without a migration.
 *
 * The `name` field is a convenience copy of `vaultName` for humans reading the file and
 * for adopting a vault folder whose registry entry was lost; `id` is the only value
 * anything should key on. It is deliberately NOT rewritten when the vault is renamed,
 * because that would make the file mutable for no gain — the registry holds the live name.
 *
 * @returns {{id: string, name: string, createdAt: string, manifestVersion: number}}
 */
export function ensureManifest() {
    const existing = readManifest();
    if (existing) return existing;

    const manifest = {
        id: crypto.randomUUID(),
        name: getConfig()?.vaultName || "default",
        createdAt: new Date().toISOString(),
        manifestVersion: MANIFEST_VERSION,
    };

    const target = manifestPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(manifest, null, 2));
    return manifest;
}

/**
 * The active vault's stable id, stamping one if the vault has never been stamped.
 * @returns {string}
 */
export function getVaultId() {
    return ensureManifest().id;
}

/**
 * Does this directory look like a Flashback vault? Used when adopting a folder the user
 * picked off disk, where we have no registry entry to trust.
 *
 * The test is the two things every vault has regardless of age: a `workspace/` directory
 * (the Seal repo / canonical layer) and a `*.db` beside it. A manifest is NOT required —
 * a vault created before this file existed has none, and refusing to adopt it would make
 * older vaults unopenable.
 *
 * @param {string} dir - Absolute path to inspect.
 * @returns {{ok: true, dbFile: string}|{ok: false, reason: string}}
 */
export function inspectVaultDir(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return { ok: false, reason: "Not a directory." };
    }
    if (!fs.existsSync(path.join(dir, "workspace"))) {
        return { ok: false, reason: "No workspace/ folder — this is not a Flashback vault." };
    }
    const dbFile = fs.readdirSync(dir).find((f) => f.endsWith(".db"));
    if (!dbFile) {
        return { ok: false, reason: "No database file — this is not a Flashback vault." };
    }
    return { ok: true, dbFile };
}
