/**
 * Toggle — an on/off switch with the switch role and keyboard behaviour that the
 * hand-built ones across the views kept forgetting. A plain <button>, so it sits
 * in forms and tab order like any other control.
 *
 *   <Toggle checked={on} onChange={setOn} label={t('Show halos')} />
 */

export default function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  className = "",
  title,
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
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
