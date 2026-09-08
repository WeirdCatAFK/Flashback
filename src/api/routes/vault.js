import { Router } from 'express';
import query from '../access/resources/query.js';
import { ensureManifest } from '../access/primitives/vault.js';
import { get as getConfig, getVaults, getActiveVaultId } from '../access/primitives/config.js';
import { switchVault, releaseVault } from '../vaultSession.js';
import { APP_VERSION } from '../appVersion.js';

const router = Router();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** GET /api/vault — who this server is and what it speaks. */
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

/** GET /api/vault/list — the registered local vaults, and which one is active. */
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

/** POST /api/vault/switch — open a different local vault in this process. */
router.post('/switch', catchError(async (req, res) => {
    const { id, name, isCustomPath = false, customPath = '' } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const result = await switchVault({ id, name, isCustomPath, customPath });
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ ok: true, vaultId: result.vault.id, vaultName: name });
}));

/** POST /api/vault/release — close the active vault's database and stop Seal's timer, without opening another. */
router.post('/release', catchError(async (req, res) => {
    await releaseVault();
    res.json({ ok: true });
}));

export default router;
