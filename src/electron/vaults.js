// Vault registry and remote registry, owned by the Electron main process.
//
// Two registries live in config.json and are written ONLY from here:
//
//   vaults[]  — the local vaults this install knows about, plus which one is active.
//   remotes[] — Flashback Server instances the user has connected to, with their
//               credentials encrypted via safeStorage.
//
// The one field main does not write is the active-vault pointer itself. Switching closes
// a database and re-points path resolvers, and only the API process can do that, so
// `switchVault()` here asks the API over HTTP and the API writes `activeVaultId` and the
// flat vaultName/isCustomPath/customPath projection. One writer per field, no split-brain.
//
// Credentials never reach the API process at all: it serves the remote LIST (so the MCP
// server and a dev:web browser can see it) while the token stays here, encrypted.

import { app, safeStorage } from "electron";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { readConfig, updateConfig, apiBaseUrl } from "./appConfig.js";
import { vaultNameError } from "../shared/vaultName.js";
import { unusableUrlReason } from "../shared/remoteUrl.js";

const MANIFEST_NAME = "vault.json";

function baseDirFor(entry) {
    return entry.isCustomPath && entry.customPath ? entry.customPath : app.getPath("userData");
}

/** Absolute path of a registry entry's vault directory. */
export function vaultRoot(entry) {
    return path.join(baseDirFor(entry), entry.name);
}

function readManifestAt(root) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), "utf-8"));
        return typeof parsed?.id === "string" && parsed.id ? parsed : null;
    } catch {
        return null;
    }
}

function stampManifestAt(root, name) {
    const existing = readManifestAt(root);
    if (existing) return existing;
    const manifest = {
        id: crypto.randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        manifestVersion: 1,
    };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
    return manifest;
}

/** Does this directory hold a vault? */
function looksLikeVault(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return "Not a directory.";
    if (!fs.existsSync(path.join(dir, "workspace"))) return "No workspace/ folder — not a Flashback vault.";
    if (!fs.readdirSync(dir).some((f) => f.endsWith(".db"))) return "No database file — not a Flashback vault.";
    return null;
}

/** Makes sure config.json has a vaults[] registry, synthesizing one from the flat fields when it does not — which is what every install upgrading into… */
export function ensureRegistry() {
    const config = readConfig();
    if (Array.isArray(config.vaults) && config.vaults.length && config.activeVaultId) return config;

    const entry = {
        name: config.vaultName || "default",
        isCustomPath: !!config.isCustomPath,
        customPath: config.customPath || "",
    };
    entry.id = stampManifestAt(vaultRoot(entry), entry.name).id;

    return updateConfig((c) => {
        c.vaults = Array.isArray(c.vaults) && c.vaults.length ? c.vaults : [entry];
        c.activeVaultId = c.activeVaultId ?? entry.id;
        if (!Array.isArray(c.remotes)) c.remotes = [];
    });
}

/** @returns {{activeVaultId: string|null, vaults: Array}} */
export function listVaults() {
    const config = readConfig();
    const vaults = Array.isArray(config.vaults) ? config.vaults : [];
    return {
        activeVaultId: config.activeVaultId ?? null,
        vaults: vaults.map((v) => ({
            ...v,
            path: vaultRoot(v),
            active: v.id === config.activeVaultId,
            missing: !fs.existsSync(vaultRoot(v)),
        })),
    };
}

function findEntry(id) {
    return (readConfig().vaults ?? []).find((v) => v.id === id) ?? null;
}

function nameTaken(name, exceptId = null) {
    return (readConfig().vaults ?? []).some(
        (v) => v.id !== exceptId && v.name.toLowerCase() === name.trim().toLowerCase()
    );
}

/** Registers a new, empty vault. */
export function createVault(name) {
    const err = vaultNameError(name);
    if (err) return { ok: false, error: `Invalid vault name (${err}).` };

    const trimmed = name.trim();
    if (nameTaken(trimmed)) return { ok: false, error: "A vault with that name is already registered." };

    const entry = { name: trimmed, isCustomPath: false, customPath: "" };
    const root = vaultRoot(entry);
    if (fs.existsSync(root)) {
        return { ok: false, error: `A folder named "${trimmed}" already exists here.` };
    }

    try {
        fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
        entry.id = stampManifestAt(root, trimmed).id;
    } catch (e) {
        return { ok: false, error: e.message };
    }

    updateConfig((c) => { (c.vaults ??= []).push(entry); });
    return { ok: true, vault: { ...entry, path: root } };
}

/** Registers a vault directory the user picked off disk — a vault restored from a backup, carried over from another machine, or one this install has… */
export function adoptVault(dirPath) {
    const problem = looksLikeVault(dirPath);
    if (problem) return { ok: false, error: problem };

    const parent = path.dirname(dirPath);
    const name = path.basename(dirPath);
    const isCustomPath = path.resolve(parent) !== path.resolve(app.getPath("userData"));
    const manifest = stampManifestAt(dirPath, name);

    const existing = (readConfig().vaults ?? []).find((v) => v.id === manifest.id);
    if (existing) return { ok: true, vault: { ...existing, path: vaultRoot(existing) }, alreadyRegistered: true };

    if (nameTaken(name)) return { ok: false, error: "A different vault with that name is already registered." };

    const entry = { id: manifest.id, name, isCustomPath, customPath: isCustomPath ? parent : "" };
    updateConfig((c) => { (c.vaults ??= []).push(entry); });
    return { ok: true, vault: { ...entry, path: dirPath } };
}

/** Unregisters a vault. */
export function removeVault(id) {
    const { vaults, activeVaultId } = listVaults();
    if (id === activeVaultId) return { ok: false, error: "Switch to another vault before removing this one." };
    if (vaults.length <= 1) return { ok: false, error: "This is the only registered vault." };
    if (!findEntry(id)) return { ok: false, error: "No such vault." };

    updateConfig((c) => { c.vaults = c.vaults.filter((v) => v.id !== id); });
    return { ok: true };
}

async function apiPost(pathname, body = {}) {
    const config = readConfig();
    const res = await fetch(`${apiBaseUrl(config)}${pathname}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...(config.apiToken ? { Authorization: `Bearer ${config.apiToken}` } : {}),
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
    }
    return res.json();
}

/**
 * Switches the running API to another registered vault.
 *
 * @returns {Promise<{ok: true, vault: object}|{ok: false, error: string}>}
 */
export async function switchVault(id) {
    const entry = findEntry(id);
    if (!entry) return { ok: false, error: "No such vault." };
    if (!fs.existsSync(vaultRoot(entry))) {
        return { ok: false, error: `The vault folder is missing: ${vaultRoot(entry)}` };
    }

    try {
        await apiPost("/api/vault/switch", entry);
        return { ok: true, vault: { ...entry, path: vaultRoot(entry) } };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

/** Renames a vault, moving its folder AND its database file together. */
export async function renameVault(id, newName) {
    const err = vaultNameError(newName);
    if (err) return { ok: false, error: `Invalid vault name (${err}).` };

    const entry = findEntry(id);
    if (!entry) return { ok: false, error: "No such vault." };

    const trimmed = newName.trim();
    if (trimmed === entry.name) return { ok: true, vault: entry };
    if (nameTaken(trimmed, id)) return { ok: false, error: "A vault with that name is already registered." };

    const oldRoot = vaultRoot(entry);
    const newRoot = vaultRoot({ ...entry, name: trimmed });
    if (fs.existsSync(newRoot)) return { ok: false, error: `A folder named "${trimmed}" already exists here.` };

    const wasActive = readConfig().activeVaultId === id;

    try {
        if (wasActive) await apiPost("/api/vault/release");

        fs.renameSync(oldRoot, newRoot);

        for (const suffix of ["", "-wal", "-shm"]) {
            const from = path.join(newRoot, `${entry.name}.db${suffix}`);
            const to = path.join(newRoot, `${trimmed}.db${suffix}`);
            if (fs.existsSync(from)) fs.renameSync(from, to);
        }
    } catch (e) {
        return { ok: false, error: `Rename failed: ${e.message}` };
    }

    updateConfig((c) => {
        const v = c.vaults.find((x) => x.id === id);
        if (v) v.name = trimmed;
    });

    if (wasActive) {
        const result = await switchVault(id);
        if (!result.ok) return result;
        try {
            await apiPost("/api/doctor/sync", { sealDrift: false });
        } catch (e) {
            return {
                ok: true,
                vault: { ...entry, name: trimmed, path: newRoot },
                warning: `Renamed, but the index could not be repaired automatically (${e.message}). Run Vault Doctor → Sync index.`,
            };
        }
    }

    return { ok: true, vault: { ...entry, name: trimmed, path: newRoot } };
}

/** The registry as the renderer sees it. */
export function listRemotes() {
    const remotes = readConfig().remotes ?? [];
    return remotes.map((r) => ({ id: r.id, label: r.label, url: r.url, hasToken: !!r.tokenEnc }));
}

function normalizeUrl(url) {
    const trimmed = String(url ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed;
}

/** Registers a remote Flashback Server. */
export function addRemote({ label, url, token }) {
    const normalized = normalizeUrl(url);
    if (!normalized) return { ok: false, error: "Enter a full URL, including http:// or https://." };

    const unusable = unusableUrlReason(normalized);
    if (unusable) return { ok: false, error: unusable };

    let tokenEnc = null;
    if (token) {
        if (!safeStorage.isEncryptionAvailable()) {
            return {
                ok: false,
                error: "This system has no secure credential store available, so the access token cannot be saved safely.",
            };
        }
        tokenEnc = safeStorage.encryptString(token).toString("base64");
    }

    const name = (label || normalized).trim();
    const entry = { id: crypto.randomUUID(), label: name, url: normalized, tokenEnc };
    updateConfig((c) => {
        c.remotes = (c.remotes ?? []).filter((r) => !(r.url === normalized && r.label === name));
        c.remotes.push(entry);
    });
    return { ok: true, remote: { id: entry.id, label: entry.label, url: entry.url, hasToken: !!tokenEnc } };
}

/** Forgets a remote and its stored credential. */
export function removeRemote(id) {
    updateConfig((c) => { c.remotes = (c.remotes ?? []).filter((r) => r.id !== id); });
    return { ok: true };
}

/** Decrypts a remote's token. Main-process only — this value never crosses to the renderer. */
function remoteToken(id) {
    const remote = (readConfig().remotes ?? []).find((r) => r.id === id);
    if (!remote?.tokenEnc) return null;
    try {
        return safeStorage.decryptString(Buffer.from(remote.tokenEnc, "base64"));
    } catch {
        return null;
    }
}

/** Handshakes with a remote: GET /api/vault, the endpoint the local API answers too. */
export async function testRemote(id) {
    const remote = (readConfig().remotes ?? []).find((r) => r.id === id);
    if (!remote) return { ok: false, error: "No such remote." };

    const unusable = unusableUrlReason(remote.url);
    if (unusable) return { ok: false, error: unusable };

    const token = remoteToken(id);
    try {
        const res = await fetch(`${remote.url}/api/vault`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 401) return { ok: false, error: "The server rejected this access token." };
        if (!res.ok) return { ok: false, error: `Server responded ${res.status}.` };
        return { ok: true, identity: await res.json() };
    } catch (e) {
        return { ok: false, error: e.name === "TimeoutError" ? "The server did not respond." : e.message };
    }
}

/** What the renderer needs to point its API client at a remote: the URL and, yes, the token — a browser fetch cannot send a header it does not have. */
export function connectionForRemote(id) {
    const remote = (readConfig().remotes ?? []).find((r) => r.id === id);
    if (!remote) return null;
    return { kind: "remote", id: remote.id, label: remote.label, url: remote.url, token: remoteToken(id) };
}
