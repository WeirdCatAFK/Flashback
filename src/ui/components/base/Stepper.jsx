/**
 * Stepper — a value with − and + beside it, for a number people nudge rather than
 * type (new cards a day, a session's size). The value keeps a fixed width so the
 * controls around it never shift as it changes. What a step does is the caller's
 * business: `onDecrease`/`onIncrease` may jump (to "All", say), and clicking the
 * value can reset it through `onValueClick`.
 *
 *   <Stepper label={t('New cards')} display={maxNew} onDecrease={less} onIncrease={more}
 *     canDecrease={maxNew > 0} canIncrease={maxNew < 200} />
 */

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
