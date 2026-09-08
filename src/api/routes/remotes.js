import { Router } from 'express';
import { getRemotes } from '../access/primitives/config.js';

const router = Router();

/** GET /api/remotes — the registered remote Flashback Server instances. */
router.get('/', (req, res) => {
    res.json({ remotes: getRemotes() });
});

export default router;
