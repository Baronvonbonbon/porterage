// Reading an amount someone typed (docs/IMPROVEMENTS.md §2).
//
// Every screen that takes an amount was doing this inline:
//
//     BigInt(Math.round(Number(text) * 1e6)) * 10n ** 12n
//
// which is three problems in one line. `Number` on anything that isn't a number
// gives NaN, and `BigInt(NaN)` throws a message about NaN that means nothing to
// whoever typed "one"; the rounding silently drops anything past six decimals,
// so 1.2345678 becomes 1.234568 without saying so; and a negative or zero
// passes straight through into a transaction.
//
// So: one parser, which either gives an amount or says what is wrong with it in
// words that can be shown next to the field.

import { parseUnits } from "ethers";

/** PAS has 18 decimals on the EVM side, which is where amounts are used. */
const DECIMALS = 18;

export type Parsed = { ok: true; wei: bigint } | { ok: false; why: string };

export function parsePas(
  text: string,
  opts: { max?: bigint; allowZero?: boolean } = {}
): Parsed {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, why: "Enter an amount." };
  if (!/^\d*\.?\d*$/.test(trimmed)) return { ok: false, why: "Numbers only." };

  const dot = trimmed.indexOf(".");
  if (dot >= 0 && trimmed.length - dot - 1 > DECIMALS) {
    return { ok: false, why: `At most ${DECIMALS} decimal places.` };
  }

  let wei: bigint;
  try {
    wei = parseUnits(trimmed === "." ? "0" : trimmed, DECIMALS);
  } catch {
    return { ok: false, why: "That isn't an amount." };
  }

  if (wei === 0n && !opts.allowZero)
    return { ok: false, why: "More than zero, please." };
  if (opts.max !== undefined && wei > opts.max)
    return { ok: false, why: "More than you have." };
  return { ok: true, wei };
}

/** The amount, or null — for a caller that only wants the value. */
export const pasOrNull = (
  text: string,
  opts?: { max?: bigint; allowZero?: boolean }
): bigint | null => {
  const parsed = parsePas(text, opts);
  return parsed.ok ? parsed.wei : null;
};

/** A whole number in a range, for counts and basis points. */
export function parseCount(
  text: string,
  opts: { min?: number; max?: number } = {}
): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return null;
  if (opts.min !== undefined && n < opts.min) return null;
  if (opts.max !== undefined && n > opts.max) return null;
  return n;
}
