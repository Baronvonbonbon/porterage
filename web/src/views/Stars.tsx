// Picking a number of stars, and showing one.
//
// Buttons again, not a slider or a select: the app's WebView is reliable about
// taps and about nothing else (views/Choose.tsx).

export function Stars({
  value,
  onPick,
  label,
}: {
  value: number;
  onPick: (n: number) => void;
  label: string;
}) {
  return (
    <div className="stars" role="group" aria-label={label}>
      <span>{label}</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={n <= value ? "star on" : "star"}
          aria-pressed={n === value}
          aria-label={`${n} of 5`}
          // Tapping the star already chosen clears it, which is how a rating
          // gets left out rather than forced.
          onClick={() => onPick(value === n ? 0 : n)}
        >
          ★
        </button>
      ))}
      {value === 0 && <span className="muted">not rating this</span>}
    </div>
  );
}
