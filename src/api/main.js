// Entry point for the api, can be called on it's own or using spawn.js to create a child process
import Api from './api.js';
import { get as getConfig } from './access/primitives/config.js';
import { openVault } from './vaultSession.js';

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in API process:', err?.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection in API process:', reason?.stack || reason);
  process.exit(1);
});

/**
 * Main entry point for the API.
 *
 * @returns {Promise<void>} A promise that is resolved when the API is started or shut down.
 */
export default async function main() {
  const opened = await openVault({
    onFatal: (msg) => console.error(`${msg} Shutting down.`),
  });
  if (!opened) process.exit(1);

  const api = new Api(await getConfig());

  api.start();
  process.on('SIGINT', async () => {
    await api.stop();
    process.exit(0);
  });
}

main();