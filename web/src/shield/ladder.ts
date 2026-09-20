// The denomination ladder: how an amount is cut into shielded notes (FARE's
// denominations.ts, docs/PLAN.md §5.1).
//
// Fixed rungs are the point. A note of an arbitrary amount is a fingerprint:
// deposit 12.437 and withdraw 12.437 and the pool has hidden nothing. Rungs put
// every note in a crowd of identical notes.
//
//   decompose  "I have this much; what can I shield?"  rounds down (payouts)
//   cover      "I need this much; what must I deposit?" rounds up (funding),
//              and the overshoot comes back as a change note
//
// Don't add a rung to grind the residue to zero: an exact-amount note is the
// fingerprint the ladder exists to prevent. Greedy is optimal only while each
// rung divides the next; keep that true.

const PAS = 10n ** 18n;

/** PAS, the pool asset. 1 to 100 PAS covers gas through a large order. */
export const LADDER_PAS: readonly bigint[] = [
  1n * PAS,
  5n * PAS,
  25n * PAS,
  100n * PAS,
];

const descending = (rungs: readonly bigint[]) =>
  [...rungs].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

export function decompose(
  amount: bigint,
  ladder: readonly bigint[]
): { rungs: bigint[]; residue: bigint } {
  const rungs: bigint[] = [];
  let left = amount;
  for (const r of descending(ladder)) {
    while (left >= r) {
      rungs.push(r);
      left -= r;
    }
  }
  return { rungs, residue: left };
}

export function cover(
  amount: bigint,
  ladder: readonly bigint[]
): { rungs: bigint[]; overshoot: bigint } {
  if (amount <= 0n) return { rungs: [], overshoot: 0n };
  const { rungs, residue } = decompose(amount, ladder);
  if (residue === 0n) return { rungs, overshoot: 0n };
  const asc = descending(ladder).reverse();
  const top = asc.find((r) => r >= residue) ?? asc[asc.length - 1];
  rungs.push(top);
  return { rungs: descending(rungs), overshoot: top - residue };
}

export const sum = (rungs: readonly bigint[]): bigint =>
  rungs.reduce((a, b) => a + b, 0n);
