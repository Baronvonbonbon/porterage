// Choosing one of a few things, without a native dropdown.
//
// The Polkadot app's WebView doesn't open the popup a <select> needs, so on a
// phone the list can be seen but nothing in it can be picked. Everything here is
// ordinary buttons: they work the same in the app, in a browser and with a
// keyboard, and a long list just wraps.

export interface Choice<T> {
  value: T;
  label: string;
  /** Shown, but not selectable — with the reason in `note`. */
  disabled?: boolean;
  note?: string;
}

export function Choose<T extends string | number>({
  value,
  choices,
  onPick,
  label,
}: {
  value: T;
  choices: Choice<T>[];
  onPick: (value: T) => void;
  label?: string;
}) {
  return (
    <div className="chooser" role="group" aria-label={label}>
      {choices.map((c) => (
        <button
          key={String(c.value)}
          type="button"
          className={c.value === value ? "chip on" : "chip"}
          aria-pressed={c.value === value}
          disabled={c.disabled}
          onClick={() => onPick(c.value)}
        >
          {c.label}
          {c.note && <span className="muted"> {c.note}</span>}
        </button>
      ))}
    </div>
  );
}
