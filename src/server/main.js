/**
 * Imports only serverConfig.js statically. A router creates the workspace directory when it loads,
 * so every other module loads after the environment merges into config.json.
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

const UNSPECIFIED_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

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
