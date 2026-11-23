export default function Stepper({
  display,
  label,
  onDecrease,
  onIncrease,
  onValueClick,
  canDecrease = true,
  canIncrease = true,
  decreaseLabel,
  increaseLabel,
  valueTitle,
  disabled = false,
}) {
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button type="button" className="stepper__step" aria-label={decreaseLabel ?? `${label} −`}
        disabled={disabled || !canDecrease} onClick={onDecrease}>−</button>
      {onValueClick ? (
        <button type="button" className="stepper__value stepper__value--button" title={valueTitle}
          disabled={disabled} onClick={onValueClick} aria-live="polite">{display}</button>
      ) : (
        <b className="stepper__value" title={valueTitle} aria-live="polite">{display}</b>
      )}
      <button type="button" className="stepper__step" aria-label={increaseLabel ?? `${label} +`}
        disabled={disabled || !canIncrease} onClick={onIncrease}>+</button>
    </span>
  );
}
