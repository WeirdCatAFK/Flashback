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
 *   5. It asks GitHub whether a newer release exists and says so in the log. The desktop app
 *      has had that since the beta (electron-updater, notify-first); a container or a zip had
 *      no way at all to learn a release had happened. It never updates itself, and it can be
 *      turned off outright - see `updateCheck.js`.
 *
 * Run:  npm run server          (see docs/SERVER.md for deployment)
 */

import process from 'process';
import { applyServerConfig } from './serverConfig.js';

const { config, authorToken } = applyServerConfig();

const { default: Api } = await import('../api/api.js');
const { openVault } = await import('../api/vaultSession.js');
const { sealEmitter } = await import('../api/seal/seal.js');
const { closeDatabase } = await import('../api/access/primitives/database.js');
const {
    ensureLocalAuthor, hasUsableToken, getAuthorAccount, issueToken, closeAccounts,
} = await import('../api/access/primitives/accounts.js');
const { APP_VERSION } = await import('../api/appVersion.js');
const { startUpdateCheck } = await import('./updateCheck.js');

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
 * @param {string|undefined} injected
 */
async function ensureSomebodyCanLogIn(injected) {
    await ensureLocalAuthor(injected ?? null);
    if (await hasUsableToken()) return;

    const author = await getAuthorAccount();
    if (!author) throw new Error('No Author account exists and one could not be created.');
    const { token } = await issueToken(author.id, 'Bootstrapped at first start');

    const rule = '='.repeat(72);
    console.log(`\n${rule}`);
    console.log('  FLASHBACK SERVER — AUTHOR TOKEN (shown once, not recoverable)');
    console.log(`\n    ${token}\n`);
    console.log('  Give this to your desktop client when adding this server as a remote.');
    console.log('  Rotate it later with:  npm run pure-token');
    console.log('  Set FLASHBACK_AUTHOR_TOKEN to supply your own instead of minting one.');
    console.log(`${rule}\n`);
}

/** Stops accepting work, then flushes it, then closes the stores — in that order. */
async function shutdown(api, updates, signal) {
    console.log(`\n${signal} received — shutting down.`);
    try {
        updates.stop();
        await api.stop();
        await sealEmitter.quiesce();
        closeDatabase();
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

/** Boots the headless server: config merge, vault open, listen, and the shutdown handlers. */
export default async function main() {
    const opened = await openVault({
        onFatal: (msg) => console.error(`${msg} Shutting down.`),
    });
    if (!opened) process.exit(1);

    await ensureSomebodyCanLogIn(authorToken);

    const updates = startUpdateCheck({ currentVersion: APP_VERSION ?? '0.0.0' });

    const api = new Api({ ...config, apiToken: authorToken ?? null, updateStatus: updates.status });
    await api.start();

    console.log(`Flashback Server — vault "${config.vaultName}", listening on ${config.host}:${config.port}`);
    if (UNSPECIFIED_HOSTS.has(config.host)) {
        console.log(`  Connect clients to  http://<this machine>:${config.port}  ` +
                    `(http://localhost:${config.port} from this computer).`);
        console.log('  Do not use the bind address above as a client URL.');
    }
    console.log('Authentication is required for every /api route.');

    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => { shutdown(api, updates, signal); });
    }
}

main();
