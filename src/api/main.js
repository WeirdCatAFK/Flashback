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