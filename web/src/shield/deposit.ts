// Topping up: the customer's host account deposits PAS into the pool as ladder
// notes (docs/PLAN.md §5.2). One tap for all the notes, any time before ordering.
//
// Keep topping up and ordering apart. Depositing N notes and spending N notes a
// minute later is a fingerprint even at fixed rungs: the count, sizes and timing
// line up. Notes hide you in the crowd only once other people's deposits and
// spends have happened in between. The UI says so.

import { SHIELD_POOL } from "../config";
import { ethProvider } from "../contracts";
import { hostAccount, hostBatch, substrate } from "../hostchain";
import { PAS_LOCATION, locationOf, planSwap, swapCall } from "../money/swap";
import type { Token } from "../money/tokens";
import { LADDER_PAS, cover, decompose, sum } from "./ladder";
import { POOL, b32, NATIVE, notePathsAt, type NotePath } from "./pool";
import { poolInserts } from "./events";
import { commitmentFor, dropNotes, reserveNotes, settleNotes } from "./notes";

/** Wei per planck: the EVM sees PAS with 18 decimals, the Substrate side with 10. */
const WEI_PER_PLANCK = 10n ** 8n;

/**
 * How many notes fit in one transaction. A deposit costs about a quarter of a
 * block's proof budget (1.65 MB of 7.9 MB for a normal extrinsic, Paseo
 * 2026-09-20), and a batch that overruns is rejected outright as
 * "ExhaustsResources". Three leaves room for a swap alongside them.
 */
export const MAX_NOTES_PER_TAP = 3;

export interface TopUp {
  rungs: bigint[];
  deposited: bigint;
  overshoot: bigint;
  /** PAS this tap left unshielded because only so many notes fit in one transaction. */
  leftOver: bigint;
  block: number;
}

/** What a top-up of `amountWei` would deposit, without doing it. */
export const planTopUp = (amountWei: bigint) => {
  const { rungs, overshoot } = cover(amountWei, LADDER_PAS);
  // Biggest first, so a capped tap shields as much as it can.
  const take = rungs.slice(0, MAX_NOTES_PER_TAP);
  const left = sum(rungs.slice(MAX_NOTES_PER_TAP));
  return { rungs: take, overshoot: left > 0n ? 0n : overshoot, total: sum(take), leftOver: left };
};

export async function topUp(amountWei: bigint): Promise<TopUp> {
  const { rungs, overshoot, total, leftOver } = planTopUp(amountWei);
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
  return { rungs, deposited: total, overshoot, leftOver, block };
}

/**
 * Shield a stablecoin: swap it to PAS and deposit the proceeds as notes, in one
 * transaction and one tap (docs/PLAN.md §5.1).
 *
 * The rungs are cut from what the swap is guaranteed to deliver, not from the
 * quote, so the batch can't ask to deposit more PAS than arrives. Anything above
 * that stays in the account as ordinary balance.
 */
export async function topUpFromToken(token: Token, amountIn: bigint): Promise<TopUp> {
  const me = await hostAccount();
  const plan = await planSwap(locationOf(token.id), PAS_LOCATION, amountIn);
  const cut = decompose(plan.minOut * WEI_PER_PLANCK, LADDER_PAS);
  const rungs = cut.rungs.slice(0, MAX_NOTES_PER_TAP);
  const leftOver = sum(cut.rungs.slice(MAX_NOTES_PER_TAP)) + cut.residue;
  if (rungs.length === 0) {
    throw new Error(`that swaps to less than the smallest note (${pasOf(LADDER_PAS[0])} PAS)`);
  }

  const recs = await reserveNotes(rungs, NATIVE);
  const commitments = await Promise.all(recs.map(commitmentFor));
  let block: number;
  try {
    ({ block } = await hostBatch([
      swapCall(plan, me.address),
      ...recs.map((r, i) => ({
        dest: SHIELD_POOL,
        data: POOL.encodeFunctionData("depositNative", [b32(commitments[i])]),
        value: BigInt(r.value) / WEI_PER_PLANCK,
      })),
    ]));
  } catch (e) {
    if (!/no answer in/.test(String(e))) await dropNotes(recs.map((r) => r.n));
    throw e;
  }

  const paths = await notePathsAt(ethProvider(), SHIELD_POOL, block, commitments, poolInserts(substrate(), SHIELD_POOL));
  await settleNotes(new Map<number, NotePath>(recs.map((r, i) => [r.n, paths[i]])));
  return { rungs, deposited: sum(rungs), overshoot: 0n, leftOver, block };
}

const pasOf = (wei: bigint) => (wei / 10n ** 18n).toString();
