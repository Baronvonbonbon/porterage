// The submitter's side of the funding market (docs/PLAN.md §5.3). Any
// participant with a little PAS runs this: a driver's session key while the app
// is open, or the optional relay. It never holds anyone's money; the proof fixes
// where the withdrawal goes.
//
// The gas estimate is the validity check: it runs the whole withdrawal, so a bad
// proof, a spent note or an evicted root fails there and costs nothing.

import { Contract, type Signer } from "ethers";
import { POOL_ABI } from "../shield/pool";
import type { FundRequest } from "./request";

export interface SubmitPolicy {
  /** Skip requests whose tip doesn't cover the gas by at least this factor. */
  minFeeOverGas: number;
}
export const DEFAULT_POLICY: SubmitPolicy = { minFeeOverGas: 1.5 };

export type SubmitOutcome =
  | { status: "sent"; hash: string; gas: bigint }
  | { status: "skipped"; reason: string };

const seen = new Set<string>();

export async function submitRequest(
  req: FundRequest,
  pool: string,
  signer: Signer,
  policy: SubmitPolicy = DEFAULT_POLICY,
): Promise<SubmitOutcome> {
  const { proof } = req;
  const key = proof.pubSignals[1]; // unique per spent note
  if (seen.has(key)) return { status: "skipped", reason: "already handled" };
  const c = new Contract(pool, POOL_ABI, signer);
  let gas: bigint;
  try {
    gas = await c.withdraw.estimateGas(proof.pA, proof.pB, proof.pC, proof.pubSignals, proof.recipient);
  } catch (e) {
    seen.add(key);
    return { status: "skipped", reason: `the pool refuses it: ${(e as { shortMessage?: string }).shortMessage ?? String(e)}` };
  }
  const price = (await signer.provider!.getFeeData()).gasPrice ?? 10n ** 12n;
  const cost = gas * price;
  if (Number(req.fee) < Number(cost) * policy.minFeeOverGas) {
    return { status: "skipped", reason: `tip ${req.fee} wei doesn't cover gas ${cost} wei` };
  }
  seen.add(key);
  const tx = await c.withdraw(proof.pA, proof.pB, proof.pC, proof.pubSignals, proof.recipient, {
    gasLimit: (gas * 6n) / 5n,
  });
  return { status: "sent", hash: tx.hash, gas };
}
