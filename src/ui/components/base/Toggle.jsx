export default function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
  title,
  ariaLabel,
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`toggle${className ? ` ${className}` : ""}`}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__knob" />
      </span>
      {label && <span className="toggle__label">{label}</span>}
    </button>
  );
}
