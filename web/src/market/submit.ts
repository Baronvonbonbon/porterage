// The submitter's side of the funding market (docs/PLAN.md §5.3). Any
// participant with a little PAS runs this: a driver's session key while the app
// is open, or the optional relay. It never holds anyone's money; the proof fixes
// where the withdrawal goes.
//
// The gas estimate is the validity check: it runs the whole withdrawal, so a bad
// proof, a spent note or an evicted root fails there and costs nothing.

import { AbiCoder, Contract, type Signer } from "ethers";
import { POOL_ABI } from "../shield/pool";
import type { FundRequest, PayoutRequest } from "./request";

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
  policy: SubmitPolicy = DEFAULT_POLICY
): Promise<SubmitOutcome> {
  const { proof } = req;
  const key = proof.pubSignals[1]; // unique per spent note
  if (seen.has(key)) return { status: "skipped", reason: "already handled" };
  const c = new Contract(pool, POOL_ABI, signer);
  let gas: bigint;
  try {
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
  if (Number(req.fee) < Number(cost) * policy.minFeeOverGas) {
    return {
      status: "skipped",
      reason: `tip ${req.fee} wei doesn't cover gas ${cost} wei`,
    };
  }
  seen.add(key);
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
  return { status: "sent", hash: tx.hash, gas };
}

const VAULT_SPEND_ABI = [
  "function depositShieldNoteZK(bytes proof, uint256 root, uint256 nullifierHash, uint96 bucket, bytes32 ksCommitment)",
];

/**
 * Submit a payee's spend into the shielded pool. Free work: the payee has
 * nothing spendable to tip with yet, and the gas is small. The proof fixes the
 * commitment the deposit funds, so there is nothing to redirect.
 */
export async function submitPayout(
  req: PayoutRequest,
  vault: string,
  signer: Signer
): Promise<SubmitOutcome> {
  if (seen.has(req.nullifierHash))
    return { status: "skipped", reason: "already handled" };
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
  seen.add(req.nullifierHash);
  const tx = await c.depositShieldNoteZK(...args, {
    gasLimit: (gas * 6n) / 5n,
  });
  return { status: "sent", hash: tx.hash, gas };
}
