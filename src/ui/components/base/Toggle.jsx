/**
 * Toggle — an on/off switch with the switch role and keyboard behaviour that the
 * hand-built ones across the views kept forgetting. A plain <button>, so it sits
 * in forms and tab order like any other control.
 *
 *   <Toggle checked={on} onChange={setOn} label={t('Show halos')} />
 *
 * Where the name is already written beside it (a settings row), pass `ariaLabel`
 * instead of `label`, so the switch is named without repeating the text.
 */

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
