// What this person prefers, on this device (docs/IMPROVEMENTS.md §5).
//
// Everything here is a display preference. None of it is published, none of it
// reaches the host, and none of it changes what anything costs — which is why
// it can live in plain localStorage while the saved location, a real fact about
// somebody, lives in the encrypted book (shield/notes.ts).
//
// The currency symbol is the one that needs watching. It sets the glyph on a
// price tier — $$ against ££ — and NOTHING ELSE. Every amount in this app is
// PAS, and a screen that printed "$4.20" over a PAS figure would be stating an
// exchange rate nobody has. If a real currency is ever shown, it needs a price
// source, a timestamp and an "as of" on screen; it does not need this setting.

const KEY = "porterage.settings.v1";

export interface Settings {
  /** The glyph used for price tiers. Decoration; see the note above. */
  symbol: string;
  /** How far to look, in metres. The saved pin itself is in the book. */
  radius: number;
}

export const SYMBOLS = ["$", "£", "€", "¥", "₹", "◈"];

/** Metres. The rungs a person actually thinks in, not a slider. */
export const RADIUS_RUNGS = [1_000, 3_000, 5_000, 10_000, 25_000];

export const DEFAULTS: Settings = { symbol: "$", radius: 5_000 };

export function settings(): Settings {
  try {
    const saved = JSON.parse(
      localStorage.getItem(KEY) ?? "{}"
    ) as Partial<Settings>;
    return {
      // A symbol from somewhere else in the app's history, or a hand-edited
      // one, is refused rather than drawn: this goes into a price tier, and an
      // unknown glyph there reads as a currency claim.
      symbol: SYMBOLS.includes(saved.symbol ?? "")
        ? saved.symbol!
        : DEFAULTS.symbol,
      radius:
        typeof saved.radius === "number" && saved.radius > 0
          ? saved.radius
          : DEFAULTS.radius,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(next: Partial<Settings>): Settings {
  const merged = { ...settings(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Private mode, blocked storage: the app still works, it just forgets.
  }
  return merged;
}
