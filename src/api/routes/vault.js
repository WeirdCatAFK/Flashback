import { Router } from 'express';
import query from '../access/resources/query.js';
import { ensureManifest } from '../access/primitives/vault.js';
import { get as getConfig, getVaults, getActiveVaultId } from '../access/primitives/config.js';
import { switchVault, releaseVault } from '../vaultSession.js';
import { APP_VERSION } from '../appVersion.js';

const router = Router();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /api/vault — who this server is and what it speaks.
 *
 * The handshake endpoint. A Flashback Server answers the same shape, which is what makes
 * "connect to a remote vault" a matter of pointing the client somewhere else: the desktop
 * app IS a Flashback Server serving one vault, so client code never learns which kind it
 * is talking to.
 *
 * The two version numbers are the compatibility contract, and they are separate on
 * purpose: `schemaVersion` describes this derived database, `canonicalVersion` describes
 * how far the vault's FILES have been brought forward. A client that understands neither
 * should refuse rather than write.
 *
 * `capabilities` announces optional features so a client can adapt without a version bump on
 * either ladder. It carries what the client cannot otherwise find out:
 *
 *   accounts      this deployment has an accounts store to manage (always true today, but a
 *                 future embedder need not)
 *   requireAuth   anonymous callers are refused — this is a served deployment, not a loopback
 *                 dev API, which is what tells the renderer to offer a Server view at all
 *   singleVault   /switch and /release are unmounted; do not offer to move this server
 *
 * It deliberately does NOT carry the caller's role. The role is already on
 * `GET /api/identity`, which resolves it from the same `req.account` the guard uses — putting
 * it here as well would be a second source for one fact, and the two would eventually differ.
 *
 * `update` is whatever the headless server's release check last learned, and is `null` on the
 * desktop build (which has electron-updater instead), when the check is turned off, and before
 * the first check has answered. It is read through a getter parked on `app.locals` by
 * `src/server/main.js` rather than imported, because this module is in the API tier and may not
 * reach into `src/server` — and because the answer changes hours after the route was mounted.
 */
router.get('/', catchError(async (req, res) => {
    const config = getConfig() || {};
    const manifest = ensureManifest();
    res.json({
        vaultId: manifest.id,
        vaultName: config.vaultName ?? null,
        appVersion: APP_VERSION,
        schemaVersion: await query.getSchemaVersion(),
        canonicalVersion: Math.max(0, ...await query.getCanonicalVersions(), 0),
        capabilities: [
            'accounts',
            ...(config.requireAuth ? ['requireAuth'] : []),
            ...(config.singleVault ? ['singleVault'] : []),
        ],
        update: req.app.locals.updateStatus?.() ?? null,
    });
}));

/**
 * GET /api/vault/list — the registered local vaults, and which one is active.
 *
 * Names and paths only; no counts or contents, which would each cost opening another
 * vault's database. Writes to this registry go through the Electron host, never here.
 */
router.get('/list', catchError(async (req, res) => {
    const activeId = getActiveVaultId();
    res.json({
        activeVaultId: activeId,
        vaults: getVaults().map(v => ({
            id: v.id,
            name: v.name,
            isCustomPath: !!v.isCustomPath,
            customPath: v.customPath || '',
            active: v.id != null && v.id === activeId,
        })),
    });
}));

/**
 * POST /api/vault/switch — open a different local vault in this process.
 * Body: { id, name, isCustomPath?, customPath? }
 *
 * Normally driven by the Electron host, which owns the registry and knows the entry is
 * real. Exposed over HTTP because the switch itself must happen inside the API process —
 * it is the process holding the database handle and Seal's pending-edit timer.
 */
router.post('/switch', catchError(async (req, res) => {
    const { id, name, isCustomPath = false, customPath = '' } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const result = await switchVault({ id, name, isCustomPath, customPath });
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ ok: true, vaultId: result.vault.id, vaultName: name });
}));

/**
 * POST /api/vault/release — close the active vault's database and stop Seal's timer,
 * without opening another.
 *
 * Exists for renaming: Windows refuses to rename a directory that holds an open file
 * handle, and the WAL/SHM files beside the database are exactly that. The host calls this,
 * renames, then calls /switch. There is no "resume" — the next database access re-opens
 * lazily against whatever config points at by then.
 */
router.post('/release', catchError(async (req, res) => {
    await releaseVault();
    res.json({ ok: true });
}));

export default router;
