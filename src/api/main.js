// Entry point for the api, can be called on it's own or using spawn.js to create a child process
import Api from './api.js';
import validate from './../api/config/validate.js';
import { get as getConfig } from './access/config.js';

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

  const api = new Api(await getConfig());

  api.start();
  process.on('SIGINT', async () => {
    await api.stop();
    process.exit(0);
  });
}

main();