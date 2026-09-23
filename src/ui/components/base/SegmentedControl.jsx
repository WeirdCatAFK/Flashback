/**
 * SegmentedControl — a few mutually exclusive choices shown side by side, for a
 * choice people compare rather than look up (a scheduler, a sort order). Each
 * segment is a button carrying `aria-pressed`, so it tabs like any other control.
 *
 *   <SegmentedControl label={t('Scheduler')} value={algo} onChange={setAlgo}
 *     options={[{ value: 'leitner', label: 'Leitner' }, { value: 'fsrs', label: 'FSRS' }]} />
 */

export default function SegmentedControl({ value, options, onChange, label, disabled = false, className = "" }) {
  return (
    <span className={`segmented${className ? ` ${className}` : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="segmented__option"
          aria-pressed={o.value === value}
          title={o.title}
          disabled={disabled || o.disabled}
          onClick={() => { if (o.value !== value) onChange(o.value); }}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
