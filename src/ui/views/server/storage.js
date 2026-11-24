const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Powers of 1024, the same units FLASHBACK_STORAGE_LIMIT accepts. */
export function byteSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function storageShare(storage) {
  if (!storage || !Number.isFinite(storage.used)) return null;
  const limit = Number.isFinite(storage.limit) && storage.limit > 0 ? storage.limit : null;
  return {
    used: byteSize(storage.used),
    limit: limit === null ? null : byteSize(limit),
    remaining: limit === null ? null : byteSize(storage.remaining ?? Math.max(0, limit - storage.used)),
    percent: limit === null ? null : Math.min(100, Math.round((storage.used / limit) * 100)),
  };
}
