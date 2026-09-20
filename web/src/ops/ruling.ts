// Arbiter ruling arithmetic (docs/PLAN.md §6, Phase 6), carried over from
// FARE's web/src/ops/ruling.ts and checked against PorterOrders.
//
// This is the preview an arbiter reads before signing `resolve()`. It has no
// authority — the contract does the real split — which is exactly why it has to
// agree with it to the wei. An arbiter shown "customer 1.5 / driver 1.5" who
// actually causes "customer 1.5000001 / driver 1.4999999" has been misled by
// their own tool, and a ruling cannot be taken back.
//
// PorterOrders.resolveDisputed:
//     customerAmt = escrow * customerShareBps / 10_000   (integer division)
//     driverAmt   = escrow - customerAmt
//
// The subtraction matters: the driver takes the truncation remainder, so the
// two sides sum to exactly the escrow and no wei is stranded. Reproducing that
// as a second multiplication would round the other way and lose dust.

export const BPS = 10_000n;

export interface EscrowSplit {
  customerAmt: bigint;
  driverAmt: bigint;
}

/** Split `escrow` the way the contract will. */
export function splitEscrow(
  escrow: bigint,
  customerShareBps: number
): EscrowSplit {
  if (
    !Number.isInteger(customerShareBps) ||
    customerShareBps < 0 ||
    customerShareBps > 10_000
  ) {
    throw new Error(
      `the customer's share must be 0–10000 basis points, not ${customerShareBps}`
    );
  }
  if (escrow < 0n) throw new Error("escrow must not be negative");
  const customerAmt = (escrow * BigInt(customerShareBps)) / BPS;
  return { customerAmt, driverAmt: escrow - customerAmt };
}

/**
 * Whether a proposed slash is more than the driver has staked. PorterDrivers
 * clamps instead of reverting, so without this the console would promise the
 * customer damages that never arrive.
 */
export const slashExceedsStake = (
  slashWei: bigint,
  driverStake: bigint
): boolean => slashWei > driverStake;

/** What the ruling does to the bond, in words, since the flag reads backwards. */
export const bondGoesTo = (openerWins: boolean): string =>
  openerWins ? "back to whoever opened the dispute" : "to the treasury";
