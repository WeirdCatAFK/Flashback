// Entry point for the api, can be called on it's own or using spawn.js to create a child process
import Api from './api.js';
import validate from './../api/config/validate.js';
import { get as getConfig } from './access/Config.js';
import { sealTools } from './seal/seal.js';

// Crash handlers: log a full stack to stderr (which the Electron host captures into the
// shared log file via api_process.js) and exit nonzero so the parent notices the death
// rather than the process wedging in a half-initialized state.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in API process:', err?.stack || err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection in API process:', reason?.stack || reason);
  process.exit(1);
});

/**
 * Main entry point for the API. Will validate the configuration, create
 * an instance of the Api class and start it. Also sets up a SIGINT
 * event listener to gracefully shut down the API when the process is
 * interrupted.
 *
 * @returns {Promise<void>} A promise that is resolved when the API is
 * started or shut down.
 */
export default async function main() {
  if (!validate()) {
    console.error("Validation failed, shutting down.");
    process.exit(1);
  }

  await sealTools.init();
  console.log("Seal initialized.");

  const api = new Api(await getConfig());

  api.start();
  process.on('SIGINT', async () => {
    await api.stop();
    process.exit(0);
  });
}

main();