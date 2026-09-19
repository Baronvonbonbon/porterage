// Topping up: the customer's host account deposits PAS into the pool as ladder
// notes (docs/PLAN.md §5.2). One tap for all the notes, any time before ordering.
//
// Keep topping up and ordering apart. Depositing N notes and spending N notes a
// minute later is a fingerprint even at fixed rungs: the count, sizes and timing
// line up. Notes hide you in the crowd only once other people's deposits and
// spends have happened in between. The UI says so.

import { SHIELD_POOL } from "../config";
import { ethProvider } from "../contracts";
import { hostBatch, substrate } from "../hostchain";
import { LADDER_PAS, cover, sum } from "./ladder";
import { POOL, b32, NATIVE, notePathsAt, type NotePath } from "./pool";
import { poolInserts } from "./events";
import { commitmentFor, dropNotes, reserveNotes, settleNotes } from "./notes";

/** Wei per planck: the EVM sees PAS with 18 decimals, the Substrate side with 10. */
const WEI_PER_PLANCK = 10n ** 8n;

export interface TopUp {
  rungs: bigint[];
  deposited: bigint;
  overshoot: bigint;
  block: number;
}

/** What a top-up of `amountWei` would deposit, without doing it. */
export const planTopUp = (amountWei: bigint) => {
  const { rungs, overshoot } = cover(amountWei, LADDER_PAS);
  return { rungs, overshoot, total: sum(rungs) };
};

export async function topUp(amountWei: bigint): Promise<TopUp> {
  const { rungs, overshoot, total } = planTopUp(amountWei);
  if (rungs.length === 0) throw new Error("nothing to deposit");

  // Note numbers are reserved and saved before anything is signed, so a crash
  // mid-deposit can never make two notes with the same secrets.
  const recs = await reserveNotes(rungs, NATIVE);
  const commitments = await Promise.all(recs.map(commitmentFor));

  let block: number;
  try {
    ({ block } = await hostBatch(
      recs.map((r, i) => ({
        dest: SHIELD_POOL,
        data: POOL.encodeFunctionData("depositNative", [b32(commitments[i])]),
        value: BigInt(r.value) / WEI_PER_PLANCK,
      })),
    ));
  } catch (e) {
    // Declined or refused before inclusion: nothing was deposited. A timeout is
    // different (it may still land), so those notes stay pending for recovery.
    if (!/no answer in/.test(String(e))) await dropNotes(recs.map((r) => r.n));
    throw e;
  }

  const paths = await notePathsAt(ethProvider(), SHIELD_POOL, block, commitments, poolInserts(substrate(), SHIELD_POOL));
  await settleNotes(new Map<number, NotePath>(recs.map((r, i) => [r.n, paths[i]])));
  return { rungs, deposited: total, overshoot, block };
}
