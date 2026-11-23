import { Router } from 'express';
import { getRemotes } from '../access/primitives/config.js';

const router = Router();

router.get('/', (req, res) => {
    res.json({ remotes: getRemotes() });
});

export default router;
