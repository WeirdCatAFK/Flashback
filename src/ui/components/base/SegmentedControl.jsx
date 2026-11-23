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
