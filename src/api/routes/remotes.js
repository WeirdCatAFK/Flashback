import { Router } from 'express';
import { getRemotes } from '../access/primitives/config.js';

const router = Router();

/**
 * GET /api/remotes — the registered remote Flashback Server instances.
 *
 * READ-ONLY, and credential-free by construction. A remote's token never reaches this
 * process: the Electron host holds it encrypted with safeStorage and attaches it to the
 * request itself, so the most this route can say about a credential is `hasToken`.
 *
 * That split is why writing is not offered here. A route that accepted a token would have
 * to store it, and the only place this process can store anything is config.json — plain
 * text, inside the user's vault directory, holding another server's credentials. Adding
 * and removing remotes is an Electron IPC concern for exactly that reason.
 *
 * The list is served over HTTP anyway because clients that are not the Electron renderer
 * — the MCP server, a `dev:web` browser session — still need to know which remotes exist.
 */
router.get('/', (req, res) => {
    res.json({ remotes: getRemotes() });
});

export default router;
