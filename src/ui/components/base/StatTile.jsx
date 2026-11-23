export default function StatTile({
  value,
  label,
  hint,
  title,
  compact = false,
  className = "",
}) {
  return (
    <div
      className={`stat-tile${compact ? " stat-tile--compact" : ""}${className ? ` ${className}` : ""}`}
      title={title}
    >
      <div className="stat-tile__value">{value}</div>
      <div className="stat-tile__label">{label}</div>
      {hint && <div className="stat-tile__hint">{hint}</div>}
    </div>
  );
}
