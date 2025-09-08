// Entry point for the api, can be called on it's own or using spawn.js to create a child process
import Api from './api.js';
import validate from './../api/config/validate.js';
import { get as getConfig } from './access/config.js';

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