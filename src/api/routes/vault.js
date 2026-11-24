import { Router } from 'express';
import * as Vault from '../access/modules/vault.js';
import { ensureManifest } from '../access/primitives/vault.js';
import { get as getConfig, getVaults, getActiveVaultId } from '../access/primitives/config.js';
import { getStorageReport } from '../access/primitives/storage.js';
import { switchVault, releaseVault } from '../vaultSession.js';
import { APP_VERSION } from '../appVersion.js';

const router = Router();
const catchError = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', catchError(async (req, res) => {
    const config = getConfig() || {};
    const manifest = ensureManifest();
    res.json({
        vaultId: manifest.id,
        vaultName: config.vaultName ?? null,
        appVersion: APP_VERSION,
        ...await Vault.versions(),
        capabilities: [
            'accounts',
            ...(config.requireAuth ? ['requireAuth'] : []),
            ...(config.singleVault ? ['singleVault'] : []),
        ],
        update: req.app.locals.updateStatus?.() ?? null,

        storage: getStorageReport(),
    });
}));

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

router.post('/switch', catchError(async (req, res) => {
    const { id, name, isCustomPath = false, customPath = '' } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name required' });

    const result = await switchVault({ id, name, isCustomPath, customPath });
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ ok: true, vaultId: result.vault.id, vaultName: name });
}));

router.post('/release', catchError(async (req, res) => {
    await releaseVault();
    res.json({ ok: true });
}));

export default router;
