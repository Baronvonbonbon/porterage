// Which notes to spend to get a given amount out.
//
// THE WALL THIS EXISTS TO REMOVE. A withdrawal spends exactly ONE note and
// pays a fee on top, so the old rule was "find a single note worth at least
// amount + fee, or give up". With buckets of 1, 5, 25 and 100 that produces
// the worst possible message: someone holding 57 PAS asks for 25, and is told
// no single note holds 26.6 — which is not only a refusal, it is a refusal
// that can never be satisfied by shielding more at that rung. Asking for a
// round bucket amount could never work, because the fee always pushed it over.
//
// So an amount is covered by SEVERAL notes, withdrawn one after another to the
// same account, and this module works out which ones.
//
// THE ARITHMETIC IS NOT "PICK NOTES UNTIL THEY ADD UP". Every note spent is
// its own withdrawal, its own proof, its own submitter and its own fee. So the
// target moves as the plan grows: covering `amount` with k notes needs
// `amount + k x ceiling`. A greedy pass that ignored that would return a plan
// that is short by exactly the fees, which is the same bug one rung down.
//
// Largest-first, because every extra note costs another fee and another wait.
// The cheapest plan is the shortest one.
//
// WHAT IT COSTS BEYOND THE FEES, said here because it is easy to miss: k
// withdrawals landing in the same account are visibly the same recipient, so
// those k notes are linked to each other. The anonymity set for one withdrawal
// is every unspent note; for a four-note plan it is still every unspent note,
// but an observer now knows those four were spent by one person. Nothing says
// WHO. It is a real cost and it is why a single-note plan is preferred whenever
// one exists.

export interface PlanNote {
  n: number;
  value: string;
}

export interface WithdrawalPlan {
  /** The notes to spend, largest first. */
  notes: PlanNote[];
  /** What to withdraw from each, in the same order. Sums to `total`. */
  draws: bigint[];
  /** What lands in the account before fees. */
  total: bigint;
  /** The most the submitters can take, all told: notes.length x ceiling. */
  fees: bigint;
  /** What the person actually asked for. */
  amount: bigint;
}

const valueOf = (n: PlanNote) => BigInt(n.value);

/**
 * A plan for `amount`, or null when the notes cannot cover it.
 *
 * `ceiling` is the most one submitter can be paid (market/auction.ts). It is
 * charged per note because each note is a separate withdrawal.
 */
export function planWithdrawal(
  amount: bigint,
  notes: PlanNote[],
  ceiling: bigint
): WithdrawalPlan | null {
  if (amount <= 0n) return null;
  const sorted = [...notes].sort((a, b) => (valueOf(b) > valueOf(a) ? 1 : -1));

  const picked: PlanNote[] = [];
  let have = 0n;
  for (const note of sorted) {
    picked.push(note);
    have += valueOf(note);
    // The target grows with the plan: one more note is one more fee.
    const need = amount + BigInt(picked.length) * ceiling;
    if (have >= need) return spread(picked, need, amount, ceiling);
  }
  return null;
}

/**
 * How much to take from each note. Largest first, taking as much as each will
 * give, so the last note is the only one that leaves change — fewer part-spent
 * notes means fewer odd-sized notes cluttering the next plan.
 */
function spread(
  notes: PlanNote[],
  total: bigint,
  amount: bigint,
  ceiling: bigint
): WithdrawalPlan {
  const draws: bigint[] = [];
  let left = total;
  for (const note of notes) {
    const take = valueOf(note) < left ? valueOf(note) : left;
    draws.push(take);
    left -= take;
  }
  // A note that ended up contributing nothing is not worth a withdrawal.
  const keep = notes.filter((_, i) => draws[i] > 0n);
  const kept = draws.filter((d) => d > 0n);
  return {
    notes: keep,
    draws: kept,
    total,
    fees: BigInt(keep.length) * ceiling,
    amount,
  };
}

/**
 * The most that can be taken out right now, after fees.
 *
 * Not simply "everything minus one fee per note": a note worth less than the
 * fee to spend it makes the answer SMALLER, so the best plan may leave dust
 * behind. This tries every prefix of the largest-first list and keeps the best,
 * which is what lets a screen offer a "take out everything" that actually works.
 */
export function maxWithdrawable(notes: PlanNote[], ceiling: bigint): bigint {
  const sorted = [...notes].sort((a, b) => (valueOf(b) > valueOf(a) ? 1 : -1));
  let best = 0n;
  let have = 0n;
  for (let k = 0; k < sorted.length; k++) {
    have += valueOf(sorted[k]);
    const net = have - BigInt(k + 1) * ceiling;
    if (net > best) best = net;
  }
  return best;
}

/** How a plan reads to a person about to approve it. */
export function describePlan(p: WithdrawalPlan): string {
  if (p.notes.length === 1) return "One withdrawal.";
  return (
    `${p.notes.length} withdrawals, one per note, each with its own fee — ` +
    `and they land in the same account, so those ${p.notes.length} notes are ` +
    `linked to each other. Nothing says whose.`
  );
}
