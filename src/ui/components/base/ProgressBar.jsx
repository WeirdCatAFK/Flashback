/**
 * ProgressBar — a fraction painted as a bar. `value` is 0..1; `tone` picks the
 * fill colour; `thick` doubles the height for standalone bars (a dialog's upload,
 * the trainer's session) versus inline ones (a file's reading position).
 */

export default function ProgressBar({
  value,
  tone = "accent",
  thick = false,
  className = "",
  label,
}) {
  const pct = Math.max(0, Math.min(1, Number(value) || 0)) * 100;
  return (
    <div
      className={`progress${thick ? " progress--thick" : ""}${className ? ` ${className}` : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
    >
      <div
        className={`progress__fill${tone === "muted" ? " progress__fill--muted" : ""}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
