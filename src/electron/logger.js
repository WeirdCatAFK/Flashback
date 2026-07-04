// src/electron/logger.js
// Centralized file logging for the packaged app. electron-log writes a rotating
// file to {userData}/logs/main.log (mirrored to the console in dev). Three sources
// feed this single sink:
//   1. the Electron main process — via the console.* patch below and direct log.* calls;
//   2. the API utility process — which has no electron-log of its own, so api_process.js
//      pipes its stdout/stderr here through logApiLine();
//   3. the renderer — window.onerror forwards over the 'renderer-error' IPC (see main.js).
import log from 'electron-log/main';

// Registers the IPC/console plumbing electron-log needs in the main process.
log.initialize();

log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB, then rotates to main.old.log
log.transports.console.level =
  process.env.NODE_ENV === 'development' ? 'silly' : 'info';

// Redirect stray console.* in the main process into the log file too, so nothing is
// lost in packaged builds where no terminal is attached. electron-log's console
// transport writes to process.stdout directly, so this does not recurse.
Object.assign(console, log.functions);

// Absolute path of the current log file — surfaced to the user in crash dialogs.
export function getLogPath() {
  return log.transports.file.getFile().path;
}

// Forward one line captured from the API utility process's stdout/stderr, tagged so
// the source is obvious in the combined log. stderr lines are logged at error level.
export function logApiLine(stream, chunk) {
  const text = chunk.toString().replace(/\r?\n$/, '');
  if (!text) return;
  if (stream === 'stderr') log.error('[api]', text);
  else log.info('[api]', text);
}

export default log;
