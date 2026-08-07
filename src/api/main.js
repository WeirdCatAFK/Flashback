// Entry point for the api, can be called on it's own or using spawn.js to create a child process
import Api from './api.js';
import validate from './../api/config/validate.js';
import { get as getConfig } from './access/primitives/config.js';
import { sealTools } from './seal/seal.js';
import runUpdates from './config/UpdateRunner.js';

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

  // Third validation stage: the canonical layer. It cannot sit inside validate() with the
  // config and database checks, because it ends in a Seal commit and Seal is only up now —
  // but it must still finish before the API is reachable, so no request can observe a
  // half-updated vault.
  //
  // Never fatal. Every read path tolerates a file that has not been updated yet, so a
  // failure logs, leaves the vault record unwritten, and the next launch tries again rather
  // than locking the user out of their own notes.
  try {
    const r = await runUpdates();
    if (r.walked) {
      console.log(
        `Canonical updates ${r.pending.join(', ') || '(re-check)'}: ` +
        `${r.documents} document(s), ${r.folders} folder(s), ${r.decks} deck file(s)` +
        (r.derivedRows ? `, ${r.derivedRows} derived row(s)` : '') +
        (r.sealedOid ? ` — sealed ${r.sealedOid.slice(0, 8)}` : '')
      );
      for (const w of r.warnings) console.warn(`Canonical update warning: ${w}`);
      if (!r.recorded) console.warn('Canonical updates incomplete — will run again next launch.');
    }
  } catch (err) {
    console.error('Canonical updates failed (continuing; will retry next launch):', err?.stack || err);
  }

  const api = new Api(await getConfig());

  api.start();
  process.on('SIGINT', async () => {
    await api.stop();
    process.exit(0);
  });
}

main();