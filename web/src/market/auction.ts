// The price of getting a stranger to send your transaction.
//
// Three of this app's rails need someone else to pay gas: a customer's shield
// withdrawal, a payee's note insertion, and an order's settlement. Before this
// module the price was a number somebody typed — 0.3 PAS in `fund.ts`, a
// governance-set flat fee in `PorterOrders` — which is either too high (the
// requester overpays every time) or too low (nobody submits, and the rail
// silently stops working).
//
// WHY A RISING PRICE RATHER THAN AN AUCTION WITH A WINNER.
//
// The obvious design is: publish the job, collect sealed quotes, pick the
// lowest after a window. It gives a true lowest price and it does not work
// here, because the requester is a phone. Picking a winner means the phone must
// still be awake 30 seconds later to make a choice and publish it, and a locked
// screen becomes a stuck withdrawal.
//
// So instead the price rises, and the first taker wins. Each submitter knows
// its own cost — its own gas estimate, at its own gas price, with its own
// margin — and takes the job the moment the offer clears that. The operator
// with the lowest real cost clears first. Lowest-price-wins falls out of the
// submitters' own arithmetic, and the requester never has to be present.
//
// What this costs: the winner is paid whatever the clock had reached, not the
// least it would have accepted. That premium is the price of not needing the
// requester awake, and `MAX_MARGIN` is the hard bound on it.
//
// The auction cannot live on-chain, and it is worth being explicit about why:
// the entire premise is a requester who cannot send a transaction. An on-chain
// auction for the right to send your transaction is circular. So it runs on the
// Statement Store, which is free, costs no tap, and holds 512 B.

import { keccak256, toUtf8Bytes, getAddress, getBytes, hexlify } from "ethers";

/**
 * The floor, as a multiple of measured gas. A submitter is never underwater:
 * this is the same 1.5x `submit.ts` has always enforced, moved somewhere both
 * sides of the market can read it.
 */
export const MIN_MARGIN_BPS = 15_000n; // 1.5x

/**
 * The ceiling. A hard cap — no request can offer more, whatever the clock says.
 *
 * It is a multiple of MEASURED gas rather than a flat figure in PAS, so it
 * stays sane when the gas price moves and on a chain that is not Paseo, with no
 * governance action needed to keep it current. A flat cap is easier to show
 * someone and wrong within a month.
 */
export const MAX_MARGIN_BPS = 40_000n; // 4x

/** How long the price takes to climb from floor to ceiling. */
export const CLIMB_SECS = 30;

/**
 * Gas units for one `shieldPool.withdraw`. A constant because it IS one: the
 * call verifies a Groth16 proof over a fixed circuit and walks a fixed-depth
 * tree, so it costs the same whatever the note holds. Only the gas price moves,
 * and that is read live wherever this is used.
 *
 * Deliberately on the generous side. Too high costs a requester a little on
 * every withdrawal; too low means the floor never clears a real submitter's
 * cost, nobody submits, and the withdrawal hangs with no explanation.
 */
export const WITHDRAW_GAS = 400_000n;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface Schedule {
  /** Never below this: the submitter's floor. Wei. */
  floor: bigint;
  /** Never above this, whatever the clock says. Wei. */
  ceiling: bigint;
  /** Unix seconds the climb started. */
  startedAt: number;
  /** Seconds from floor to ceiling. */
  climbSecs: number;
}

/** The schedule a request publishes, from the gas it is expected to cost. */
export function scheduleFor(
  gasCost: bigint,
  startedAt: number = nowSeconds(),
  climbSecs: number = CLIMB_SECS
): Schedule {
  if (gasCost < 0n) throw new Error("gas cost cannot be negative");
  return {
    floor: (gasCost * MIN_MARGIN_BPS) / 10_000n,
    ceiling: (gasCost * MAX_MARGIN_BPS) / 10_000n,
    startedAt,
    climbSecs,
  };
}

/**
 * What the request is offering at `at`.
 *
 * Clamped at both ends: before the start it is the floor, after the climb it is
 * the ceiling and stays there. A submitter that arrives late is not offered
 * more than the cap, and a clock that runs backwards cannot produce a price
 * below the floor.
 */
export function priceAt(s: Schedule, at: number = nowSeconds()): bigint {
  if (s.climbSecs <= 0) return s.ceiling;
  const elapsed = Math.min(Math.max(at - s.startedAt, 0), s.climbSecs);
  const span = s.ceiling - s.floor;
  return s.floor + (span * BigInt(elapsed)) / BigInt(s.climbSecs);
}

/** What a submitter needs the job to pay before it is worth doing. */
export const worthDoing = (gasCost: bigint, marginBps = MIN_MARGIN_BPS): bigint =>
  (gasCost * marginBps) / 10_000n;

// ── claims ──────────────────────────────────────────────────────────────────
//
// Without this, the market is a race: two submitters see the same request, both
// send, and the one that lands second pays full gas for a transaction that
// reverts on the nullifier. Correctness is fine — the nullifier is doing its
// job — but the waste is real money and it drives honest submitters away.
//
// So a submitter says "mine" before sending, and backs off if someone else's
// claim is still live. Statements are free and cost no tap, so this costs
// nothing to do. It is not airtight: two claims can cross in flight, and a
// claim is not binding on anyone. It turns the common case from a race into a
// queue, and nothing depends on it for correctness.

export const CLAIM_TOPIC = keccak256(toUtf8Bytes("porterage:claim:v1"));

/** Long enough to get a transaction in, short enough that a quitter frees it. */
export const CLAIM_TTL_S = 20;

export const CLAIM_BYTES = 54;
const CLAIM_VERSION = 1;

export interface Claim {
  /** What is being claimed: the request's unique key (a nullifier hash). */
  key: string;
  /** Who claims it. */
  claimant: string;
}

/** One channel per claimant per request, so two claims never overwrite. */
export const claimChannel = (key: string, claimant: string): string =>
  keccak256(
    toUtf8Bytes(`porterage:claim:${normalKey(key)}:${claimant.toLowerCase()}`)
  );

/** Keys arrive as decimal strings from the circuit and hex from the chain. */
function normalKey(key: string): string {
  const n = key.startsWith("0x") ? BigInt(key) : BigInt(key);
  return "0x" + n.toString(16).padStart(64, "0");
}

export function encodeClaim(c: Claim): Uint8Array {
  const out = new Uint8Array(CLAIM_BYTES);
  out[0] = CLAIM_VERSION;
  out[1] = 0;
  out.set(getBytes(normalKey(c.key)), 2);
  out.set(getBytes(getAddress(c.claimant)), 34);
  return out;
}

export function decodeClaim(b: Uint8Array): Claim | null {
  if (b.length !== CLAIM_BYTES || b[0] !== CLAIM_VERSION) return null;
  try {
    return {
      key: hexlify(b.slice(2, 34)),
      claimant: getAddress(hexlify(b.slice(34, 54))),
    };
  } catch {
    return null;
  }
}

/**
 * Live claims, by request key. A submitter keeps one of these from the claim
 * topic and asks it before sending.
 */
export class Claims {
  private held = new Map<string, { claimant: string; at: number }>();

  heard(c: Claim, at: number = nowSeconds()): void {
    const key = normalKey(c.key);
    const prev = this.held.get(key);
    // First claim wins for as long as it is live; a later one does not displace
    // it, or a straggler could take a job somebody is already paying gas for.
    if (!prev || at - prev.at >= CLAIM_TTL_S) {
      this.held.set(key, { claimant: c.claimant, at });
    }
  }

  /** Someone else's live claim on this request, if there is one. */
  heldByOther(
    key: string,
    me: string,
    at: number = nowSeconds()
  ): string | null {
    const held = this.held.get(normalKey(key));
    if (!held) return null;
    if (at - held.at >= CLAIM_TTL_S) return null;
    return held.claimant.toLowerCase() === me.toLowerCase()
      ? null
      : held.claimant;
  }

  forget(key: string): void {
    this.held.delete(normalKey(key));
  }
}
