// Sending a transaction on a chain that can refuse one for being too big to
// prove.
//
// PolkaVM, which is what these contracts actually run on through
// pallet-revive, meters PROOF SIZE as well as gas, and the proof-size budget
// is per block as much as per transaction. When a block is busy, a
// transaction that would succeed on its own is included and then reverted,
// having done nothing.
//
// This is not theoretical and it is not rare. Two of a hundred live orders
// failed this way on 2026-09-24, both in the same block: two customers
// happened to create orders at the same moment, and one of them was thrown
// away. The same limit forced the contract migration's venue import to split
// itself into batches of 8 and 7 after a batch of 15 was refused.
//
// The failure is silent in the worst way. The transaction is mined, so it is
// not "pending"; it reverts, so the app reports it as an error; and it carries
// no revert reason, so there is nothing to tell the person. A customer would
// see their order fail for no stated reason and would simply try again — which
// is exactly what this does for them, only immediately and without them having
// to understand any of it.
//
// TELLING IT APART FROM A REAL REVERT is the whole difficulty, because
// retrying a genuine `require` failure would turn one clear error into three
// slow ones. Two signals together:
//
//   1. No revert data. Every `require` in these contracts carries a message —
//      "not-customer", "bad-pickup-window" — and ethers surfaces it as
//      `reason`. A resource refusal has none.
//   2. Barely any gas used. The refusal above consumed 1,905 gas. The
//      cheapest real call in the system, `cancelOpen`, measured 5,393 across
//      a hundred orders, and a revert that ran far enough to fail a require
//      costs more than doing nothing at all.
//
// Both must hold. A `require(false)` with no message would satisfy the first
// on its own, and that is the case this must not retry.

import type { ContractTransactionResponse, TransactionReceipt } from "ethers";

/**
 * Below this, the transaction cannot have executed anything meaningful.
 * `cancelOpen`, the cheapest real call, is 5,393 gas measured live.
 */
const TRIVIAL_GAS = 3_000n;

/** How the chain says "not this block" at estimate time rather than on chain. */
const RESOURCE_WORDS = /OutOfGas|proof size|exhausted|Resources?Exhausted/i;

interface MaybeRevert {
  reason?: string | null;
  revert?: unknown;
  data?: string | null;
  receipt?: { status?: number | null; gasUsed?: bigint } | null;
  message?: string;
  info?: { error?: { message?: string } };
}

/**
 * Was this the chain refusing to make room, rather than the contract saying
 * no? Exported because the same question gets asked of estimateGas failures
 * in the migration and fleet tooling.
 */
export function isResourceRefusal(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as MaybeRevert;

  // Refused before inclusion: the node tells us outright.
  const text = `${err.message ?? ""} ${err.info?.error?.message ?? ""}`;
  if (RESOURCE_WORDS.test(text)) return true;

  // Included and reverted. Both signals, never one.
  const rec = err.receipt;
  if (!rec || rec.status !== 0) return false;
  const noReason = !err.reason && !err.revert && (!err.data || err.data === "0x");
  const barelyRan = rec.gasUsed !== undefined && rec.gasUsed < TRIVIAL_GAS;
  return noReason && barelyRan;
}

export interface SendOptions {
  /** Extra attempts after the first. Three tries total by default. */
  retries?: number;
  /** Told what is happening, so a screen can say "the chain was busy". */
  onRetry?: (attempt: number) => void;
  /** Wait before the first retry, doubled-ish after. Roughly a block. */
  backoffMs?: number;
}

/**
 * Send a transaction, and send it again if the chain refused it for room.
 *
 * Takes a function rather than a transaction, because a refused transaction
 * cannot be re-awaited — it has to be built and signed afresh. The waits
 * between attempts are roughly a block apiece: the point is to land in a
 * different block from whatever crowded this one out.
 */
export async function send(
  make: () => Promise<ContractTransactionResponse>,
  { retries = 2, onRetry, backoffMs = 1_500 }: SendOptions = {}
): Promise<TransactionReceipt> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      onRetry?.(attempt);
      await new Promise((r) => setTimeout(r, backoffMs * attempt));
    }
    try {
      const tx = await make();
      const rec = await tx.wait();
      if (!rec) throw new Error("the transaction produced no receipt");
      return rec;
    } catch (e) {
      last = e;
      if (!isResourceRefusal(e)) throw e;
    }
  }
  throw last;
}
