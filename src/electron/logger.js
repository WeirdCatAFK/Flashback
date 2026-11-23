import log from 'electron-log/main';

log.initialize();

log.transports.file.level = 'info';
log.transports.file.maxSize = 5 * 1024 * 1024;
log.transports.console.level =
  process.env.NODE_ENV === 'development' ? 'silly' : 'info';

Object.assign(console, log.functions);

export function getLogPath() {
  return log.transports.file.getFile().path;
}

export function logApiLine(stream, chunk) {
  const text = chunk.toString().replace(/\r?\n$/, '');
  if (!text) return;
  if (stream === 'stderr') log.error('[api]', text);
  else log.info('[api]', text);
}

export default log;
