// The submitter's side of the funding market (docs/PLAN.md §5.3). Any
// participant with a little PAS runs this: a driver's session key while the app
// is open, or the optional relay. It never holds anyone's money; the proof fixes
// where the withdrawal goes.
//
// The gas estimate is the validity check: it runs the whole withdrawal, so a bad
// proof, a spent note or an evicted root fails there and costs nothing.

import { AbiCoder, Contract, type Signer } from "ethers";
import { POOL_ABI } from "../shield/pool";
import { MIN_MARGIN_BPS, worthDoing, type Claims } from "./auction";
import { feeNow, type FundRequest, type PayoutRequest } from "./request";

export interface SubmitPolicy {
  /**
   * What this operator needs over its own gas, in basis points. 15000 = 1.5x.
   * Lowering it wins more jobs at thinner margins; raising it wins fewer.
   * It is the only knob that decides which operator takes a job first.
   */
  minMarginBps: bigint;
}
export const DEFAULT_POLICY: SubmitPolicy = { minMarginBps: MIN_MARGIN_BPS };

export type SubmitOutcome =
  | { status: "sent"; hash: string; gas: bigint; fee: bigint }
  /** Not now, but ask again: the price is still climbing, or someone has it. */
  | { status: "waiting"; reason: string; offer: bigint; need: bigint }
  | { status: "skipped"; reason: string };

export interface SubmitOptions {
  policy?: SubmitPolicy;
  /** Live claims from other submitters, to avoid racing them for gas. */
  claims?: Claims;
  /** Say "mine" before sending. Free: a statement, no tap. */
  announce?: (key: string) => Promise<void>;
  /** Overridable so a test need not mock the clock globally. */
  now?: () => number;
}

/**
 * Permanently handled: a spent note, a bad proof, an evicted root. NOT a
 * request that is merely too cheap right now — that one must be reconsidered
 * as the price climbs, and treating it as handled is how a rising-price market
 * silently degrades into no market at all.
 */
const seen = new Set<string>();

export function _forgetSeen(): void {
  seen.clear();
}

export async function submitRequest(
  req: FundRequest,
  pool: string,
  signer: Signer,
  opts: SubmitOptions = {}
): Promise<SubmitOutcome> {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const at = opts.now?.();
  const { proof } = req;
  const key = proof.pubSignals[1]; // unique per spent note
  if (seen.has(key)) return { status: "skipped", reason: "already handled" };

  // Back off before spending anything on an estimate: if someone else called
  // it, the gas we are about to price is gas we would burn on a revert.
  const me = await signer.getAddress();
  const holder = opts.claims?.heldByOther(key, me, at);
  if (holder) {
    return {
      status: "waiting",
      reason: `claimed by ${holder}`,
      offer: 0n,
      need: 0n,
    };
  }

  const c = new Contract(pool, POOL_ABI, signer);
  let gas: bigint;
  try {
    // The estimate is also the validity check: it runs the whole withdrawal, so
    // a bad proof, a spent note or an evicted root fails here and costs nothing.
    gas = await c.withdraw.estimateGas(
      proof.pA,
      proof.pB,
      proof.pC,
      proof.pubSignals,
      proof.recipient
    );
  } catch (e) {
    seen.add(key);
    return {
      status: "skipped",
      reason: `the pool refuses it: ${
        (e as { shortMessage?: string }).shortMessage ?? String(e)
      }`,
    };
  }
  const price = (await signer.provider!.getFeeData()).gasPrice ?? 10n ** 12n;
  const cost = gas * price;
  const need = worthDoing(cost, policy.minMarginBps);
  const offer = feeNow(req, at);
  if (offer < need) {
    return {
      status: "waiting",
      reason: `offer ${offer} wei is under this operator's ${need} wei`,
      offer,
      need,
    };
  }

  seen.add(key);
  await opts.announce?.(key).catch(() => undefined);
  const tx = await c.withdraw(
    proof.pA,
    proof.pB,
    proof.pC,
    proof.pubSignals,
    proof.recipient,
    {
      gasLimit: (gas * 6n) / 5n,
    }
  );
  return { status: "sent", hash: tx.hash, gas, fee: offer };
}

const VAULT_SPEND_ABI = [
  "function depositShieldNoteZK(bytes proof, uint256 root, uint256 nullifierHash, uint96 bucket, bytes32 ksCommitment)",
];

/**
 * Submit a payee's spend into the shielded pool. Free work: the payee has
 * nothing spendable to tip with yet, and the gas is small. The proof fixes the
 * commitment the deposit funds, so there is nothing to redirect.
 *
 * WHY THIS ONE PAYS NOTHING, when every other rail now runs an auction.
 *
 * `depositShieldNoteZK` burns a note of exactly `bucket` and deposits exactly
 * `bucket`. The amount is fixed by the proof and by the commitment; there is no
 * slack in it. A fee could only come out of the bucket — and the fixed
 * denominations (1, 5, 25, 100 PAS) ARE the anonymity set. A deposit of 4.97
 * PAS is a fingerprint that identifies its owner across the pool for as long as
 * the pool exists. That is a bad trade at any fee.
 *
 * So this stays a public good, and gets the other half of a market instead: a
 * bound, so a submitter can see what it will cost before agreeing to do it
 * rather than discovering it in the gas bill.
 */
export async function submitPayout(
  req: PayoutRequest,
  vault: string,
  signer: Signer,
  opts: { maxGasCost?: bigint; claims?: Claims; now?: () => number } = {}
): Promise<SubmitOutcome> {
  if (seen.has(req.nullifierHash))
    return { status: "skipped", reason: "already handled" };

  const me = await signer.getAddress();
  const holder = opts.claims?.heldByOther(req.nullifierHash, me, opts.now?.());
  if (holder)
    return {
      status: "waiting",
      reason: `claimed by ${holder}`,
      offer: 0n,
      need: 0n,
    };
  const proof = AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [req.words.slice(0, 2), req.words.slice(2, 6), req.words.slice(6, 8)]
  );
  const c = new Contract(vault, VAULT_SPEND_ABI, signer);
  const args = [
    proof,
    req.root,
    req.nullifierHash,
    req.bucket,
    req.ksCommitment,
  ] as const;
  let gas: bigint;
  try {
    gas = await c.depositShieldNoteZK.estimateGas(...args);
  } catch (e) {
    seen.add(req.nullifierHash);
    return {
      status: "skipped",
      reason: `the vault refuses it: ${
        (e as { shortMessage?: string }).shortMessage ?? String(e)
      }`,
    };
  }
  // The bound. Unpaid work should still never be unbounded work.
  if (opts.maxGasCost !== undefined) {
    const price = (await signer.provider!.getFeeData()).gasPrice ?? 10n ** 12n;
    const cost = gas * price;
    if (cost > opts.maxGasCost) {
      return {
        status: "waiting",
        reason: `gas ${cost} wei is over this operator's ${opts.maxGasCost} wei bound`,
        offer: 0n,
        need: cost,
      };
    }
  }

  seen.add(req.nullifierHash);
  const tx = await c.depositShieldNoteZK(...args, {
    gasLimit: (gas * 6n) / 5n,
  });
  return { status: "sent", hash: tx.hash, gas, fee: 0n };
}
