import path from "path";
import fs from "fs";
import crypto from "crypto";
import { getVaultPath, get as getConfig } from "./config.js";

export const MANIFEST_VERSION = 1;

const MANIFEST_NAME = "vault.json";

function manifestPath() {
    return path.join(getVaultPath(), MANIFEST_NAME);
}

function readManifest() {
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath(), "utf-8"));
        return typeof parsed?.id === "string" && parsed.id ? parsed : null;
    } catch {
        return null;
    }
}

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

export function getVaultId() {
    return ensureManifest().id;
}

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
