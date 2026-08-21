/**
 * Flashback Server — the headless entry point.
 *
 * The same backend the desktop app runs, booted without Electron: one vault, several people,
 * reached over HTTP and authenticated by token. It is deliberately a thin wrapper, because
 * everything that makes a server different from a desktop install was built INTO `src/api`
 * across M1–M3 rather than forked here:
 *
 *   - accounts, roles and `req.account`            (M1, `auth/`)
 *   - per-person study progress                    (M2, the account scope)
 *   - stale-write detection and the path lock      (M3, `ifMatch` + `pathLock.js`)
 *
 * So this file's whole job is: read the environment, open the vault, make sure somebody can
 * authenticate, listen, and shut down cleanly. Anything more belongs in `src/api`, where the
 * desktop build gets it too.
 *
 * Differences from `src/api/main.js` (the Electron-hosted entry), all of them intentional:
 *
 *   1. `requireAuth` is on — an anonymous caller is refused rather than treated as the
 *      Author. On loopback that fallback is a convenience; on a network it is an open door.
 *   2. `singleVault` is on — `/api/vault/switch` and `/release` are unmounted. There is no
 *      second vault to move to, and a switch closes the database under every connected user.
 *   3. It binds every interface by default instead of localhost.
 *   4. It handles SIGTERM, because that is how a container is asked to stop.
 *
 * Run:  npm run server          (see docs/SERVER.md for deployment)
 */

import process from 'process';
import { applyServerConfig } from './serverConfig.js';

// ── Why the rest of the imports are dynamic ────────────────────────────────────────────
//
// `import` is hoisted: every static import in a module runs before the module's first
// statement. And importing `api.js` pulls in every router, seven of which do
// `const docs = new Documents()` at module scope — whose constructor builds `new Files()`,
// whose constructor CREATES the workspace directory. All of that resolves its paths from
// whatever `config.json` says at import time.
//
// So a static import here would create `{volume}/{default vault}/workspace` before
// `applyServerConfig()` had a chance to apply FLASHBACK_VAULT_NAME, leaving a spurious
// empty vault sitting on the volume next to the real one. (It did. That is how this comment
// came to exist.) `serverConfig.js` is safe to import statically because it reaches only
// `config.js`, which has no filesystem side effects beyond the config file itself.
//
// The test suite documents the same ordering rule for the same reason.
const { config, authorToken } = applyServerConfig();

const { default: Api } = await import('../api/api.js');
const { openVault } = await import('../api/vaultSession.js');
const { sealEmitter } = await import('../api/seal/seal.js');
const { closeDatabase } = await import('../api/access/primitives/database.js');
const {
    ensureLocalAuthor, hasUsableToken, getAuthorAccount, issueToken, closeAccounts,
} = await import('../api/access/primitives/accounts.js');

// Same contract as the Electron-hosted API process: log a full stack and exit nonzero, so a
// supervisor (systemd, Docker's restart policy, Kubernetes) sees the death and restarts,
// rather than the process wedging half-initialized and answering requests badly.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception in Flashback Server:', err?.stack || err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection in Flashback Server:', reason?.stack || reason);
    process.exit(1);
});

/**
 * Makes sure somebody can authenticate before the server starts refusing everybody.
 *
 * `Api.start()` already refuses to boot when `requireAuth` is set and no usable token
 * exists — correct, but on a fresh volume that is every first start, and "it refused to
 * boot" is a poor first experience for a container that had no way to be given a token yet.
 *
 * So: adopt `FLASHBACK_AUTHOR_TOKEN` when one was injected, otherwise mint one and print it
 * once. Both paths go through `accounts.js`'s existing helpers — no new token code, and the
 * store keeps only the SHA-256 either way.
 *
 * @param {string|undefined} injected
 */
async function ensureSomebodyCanLogIn(injected) {
    await ensureLocalAuthor(injected ?? null);
    if (await hasUsableToken()) return;

    const author = await getAuthorAccount();
    if (!author) throw new Error('No Author account exists and one could not be created.');
    const { token } = await issueToken(author.id, 'Bootstrapped at first start');

    // Loud on purpose. This is the only time the plaintext is ever available — the store
    // holds a hash — and a line lost in startup noise is a vault nobody can reach.
    const rule = '='.repeat(72);
    console.log(`\n${rule}`);
    console.log('  FLASHBACK SERVER — AUTHOR TOKEN (shown once, not recoverable)');
    console.log(`\n    ${token}\n`);
    console.log('  Give this to your desktop client when adding this server as a remote.');
    console.log('  Rotate it later with:  npm run pure-token');
    console.log('  Set FLASHBACK_AUTHOR_TOKEN to supply your own instead of minting one.');
    console.log(`${rule}\n`);
}

/**
 * Stops accepting work, then flushes it, then closes the stores — in that order.
 *
 * The ordering is the same argument `switchVault()` makes, adapted to a shutdown. There,
 * the `switching` flag is what stops new requests before Seal is quiesced; here, closing the
 * listener is. Flushing before the socket is closed would race the requests still arriving,
 * and closing the database before Seal has flushed would strand a commit mid-write.
 *
 * `closeDatabase()` truncates the WAL on the way out, which is what leaves the volume
 * consistent for the next container — the whole reason this is not just `process.exit()`.
 */
async function shutdown(api, signal) {
    console.log(`\n${signal} received — shutting down.`);
    try {
        await api.stop();              // stop accepting; in-flight requests finish
        await sealEmitter.quiesce();   // flush the review debounce and drain the commit queue
        closeDatabase();               // checkpoint the WAL
        closeAccounts();
        console.log('Shutdown complete.');
        process.exit(0);
    } catch (err) {
        console.error('Error during shutdown:', err?.stack || err);
        process.exit(1);
    }
}

/** Bind addresses that mean "every interface" and are never a destination. */
const UNSPECIFIED_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

export default async function main() {
    const opened = await openVault({
        onFatal: (msg) => console.error(`${msg} Shutting down.`),
    });
    if (!opened) process.exit(1);

    await ensureSomebodyCanLogIn(authorToken);

    const api = new Api({ ...config, apiToken: authorToken ?? null });
    await api.start();

    console.log(`Flashback Server — vault "${config.vaultName}", listening on ${config.host}:${config.port}`);
    // 0.0.0.0 and :: are BIND addresses — "every interface" — and are not addresses anything
    // connects to. Printing one as though it were a destination is how it ends up pasted into
    // a client: Node's fetch will happily resolve it, so the handshake passes, and then the
    // renderer (Chromium, which refuses the unspecified address outright) cannot reach the
    // server at all. Say what to connect to instead.
    if (UNSPECIFIED_HOSTS.has(config.host)) {
        console.log(`  Connect clients to  http://<this machine>:${config.port}  ` +
                    `(http://localhost:${config.port} from this computer).`);
        console.log('  Do not use the bind address above as a client URL.');
    }
    console.log('Authentication is required for every /api route.');

    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => { shutdown(api, signal); });
    }
}

main();
