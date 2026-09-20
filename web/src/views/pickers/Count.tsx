// How many of something (docs/IMPROVEMENTS.md §2).
//
// Picking two coffees by typing "2" into a text box works until a thumb is
// involved. This is the one place a stepper genuinely beats a field: small
// numbers, changed one at a time, next to the thing being counted.

export function Count({
  value,
  onChange,
  max = 99,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  max?: number;
  label: string;
}) {
  const set = (n: number) => onChange(Math.max(0, Math.min(max, n)));
  return (
    <span className="count" role="group" aria-label={label}>
      <button
        type="button"
        className="step"
        disabled={value <= 0}
        onClick={() => set(value - 1)}
        aria-label={`one fewer ${label}`}
      >
        −
      </button>
      <span className="count-value" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="step"
        disabled={value >= max}
        onClick={() => set(value + 1)}
        aria-label={`one more ${label}`}
      >
        +
      </button>
    </span>
  );
}
