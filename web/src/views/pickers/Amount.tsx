// Typing an amount of PAS (docs/IMPROVEMENTS.md §2).
//
// A bare text box is how someone funds the wrong thing by a factor of ten, and
// how "one" becomes "Cannot convert NaN to a BigInt" at the bottom of a screen
// half a second after the tap. So: presets for the amounts people actually
// mean, and the complaint next to the field rather than after the attempt.
//
// It reports the parsed value as well as the text, so a caller never parses
// again — two parsers is two answers.

import { parsePas } from "../../money/amount";

export function Amount({
  label,
  value,
  onChange,
  presets,
  max,
  hint,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (text: string, wei: bigint | null) => void;
  /** Whole PAS, offered as chips. The commonest amounts, not every amount. */
  presets?: number[];
  /** What this device can actually spend, so the complaint can say so. */
  max?: bigint;
  hint?: string;
  disabled?: boolean;
}) {
  const parsed = parsePas(value, { max });
  // Silence while the field is empty: nobody needs telling off before they
  // have typed anything.
  const complaint = value.trim() && !parsed.ok ? parsed.why : null;
  const put = (text: string) => {
    const now = parsePas(text, { max });
    onChange(text, now.ok ? now.wei : null);
  };

  return (
    <div className="amount">
      <label>
        {label}{" "}
        <input
          inputMode="decimal"
          size={8}
          value={value}
          disabled={disabled}
          aria-invalid={!!complaint}
          onChange={(e) => put(e.target.value)}
        />{" "}
        PAS
      </label>
      {presets && presets.length > 0 && (
        <div className="chooser">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              className={
                parsed.ok && parsed.wei === BigInt(p) * 10n ** 18n
                  ? "chip on"
                  : "chip"
              }
              disabled={
                disabled || (max !== undefined && BigInt(p) * 10n ** 18n > max)
              }
              onClick={() => put(String(p))}
            >
              {p}
            </button>
          ))}
        </div>
      )}
      {complaint && <p className="error">{complaint}</p>}
      {!complaint && hint && <p className="muted">{hint}</p>}
    </div>
  );
}
