import { Router } from 'express';
import { getIdentity, getAuthorString } from '../access/primitives/config.js';

const router = Router();

/**
 * GET /api/identity — who this install stamps work as.
 *
 * The local, git-style identity: a self-asserted name and email that goes into a sidecar's
 * `createdBy` and onto every Seal commit. `source` says where it came from — a per-vault
 * override, the global setting, or derived from the OS account when nothing is set.
 *
 * READ-ONLY, for the same reason as /api/remotes: the field lives in config.json, and
 * config.json's writers are split by ownership — the Electron main process owns `user`,
 * this process owns only the active-vault pointer. A route that wrote here would put two
 * processes on the same key. Editing goes through IPC.
 *
 * Served over HTTP anyway so clients that are not the Electron renderer — the MCP server,
 * a `dev:web` browser session — can show whose work they are looking at.
 *
 * NOT authentication. Nothing validates any of this and nothing gates on it; a Flashback
 * Server must treat an identity a client asserts as exactly that. What authorizes a remote
 * is its access token.
 */
router.get('/', (req, res) => {
    const { name, email, source } = getIdentity();
    res.json({ name, email, source, author: getAuthorString() });
});

export default router;
