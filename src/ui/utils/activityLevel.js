export function heatLevel(n, max) {
  if (!n || n <= 0 || !max) return 0;
  const r = n / max;
  return r <= 0.25 ? 1 : r <= 0.5 ? 2 : r <= 0.75 ? 3 : 4;
}
