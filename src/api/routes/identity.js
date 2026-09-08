import { Router } from 'express';
import { getIdentity, getAuthorString } from '../access/primitives/config.js';

const router = Router();

/** GET /api/identity — who this install stamps work as. */
router.get('/', (req, res) => {
    const { name, email, source } = getIdentity();
    res.json({
        name, email, source,
        author: getAuthorString(),
        account: req.account
            ? { id: req.account.id, name: req.account.name, email: req.account.email, role: req.account.role }
            : null,
    });
});

export default router;
