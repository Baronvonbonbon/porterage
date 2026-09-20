// Running a private payout (docs/PLAN.md §5.6), in two steps a payee takes at
// different times:
//
//   shieldEarnings  one tap: a bucket of vault balance becomes a note
//   releaseEarnings the proof, posted to the market for a stranger to submit;
//                   the money lands in Kusama Shield as an ordinary pool note
//
// Doing both at once would pair the insert with the deposit by timing, so the
// app keeps them apart and says so.

import { SHIELD_POOL } from "../config";
import { ABI, addressOf, ethProvider } from "../contracts";
import { hostCall, substrate } from "../hostchain";
import { encodePayout } from "../market/request";
import { publishRequest } from "../market/statements";
import { contractEvents, poolInserts } from "./events";
import { commitmentFor, reserveNotes, reservePayout, settleNotes, updatePayout, type PayoutRecord } from "./notes";
import { findLeafBlock, notePathsAt } from "./pool";
import { INSERTED_TOPIC, noteLeaves, payoutCommitment, payoutNote, proveSpend } from "./payout";

const POLL_MS = 5_000;
const WAIT_MS = 15 * 60_000;

/** One tap: turn `bucket` of vault balance into a note in the vault's tree. */
export async function shieldEarnings(bucket: bigint): Promise<PayoutRecord> {
  const rec = await reservePayout(bucket);
  const note = await payoutNote(rec.n, bucket);
  const { block } = await hostCall(
    addressOf("vault"),
    ABI.vault.encodeFunctionData("insertShieldNote", [bucket, payoutCommitment(note)]),
  );
  await updatePayout(rec.n, { insertedAt: block });
  return { ...rec, insertedAt: block };
}

export type ReleaseStage = "reading" | "proving" | "posting" | "waiting" | "settling" | "done";

/**
 * Prove ownership of the payout note and post the spend. A stranger submits it,
 * and the money arrives as a pool note this device can spend like any other.
 */
export async function releaseEarnings(rec: PayoutRecord, onStage: (s: ReleaseStage) => void): Promise<void> {
  const provider = ethProvider();
  const bucket = BigInt(rec.bucket);
  const vault = addressOf("vault");

  onStage("reading");
  const leaves = await noteLeaves(
    provider,
    vault,
    rec.insertedAt ?? 0,
    contractEvents(substrate(), vault, [INSERTED_TOPIC]),
  );

  // The pool note the deposit will fund: derived here, spendable later.
  const [ksNote] = await reserveNotes([bucket]);
  const ksCommitment = await commitmentFor(ksNote);

  onStage("proving");
  const spend = await proveSpend(await payoutNote(rec.n, bucket), leaves, ksCommitment);

  onStage("posting");
  await publishRequest(
    encodePayout({
      bucket,
      root: spend.root,
      nullifierHash: spend.nullifierHash,
      ksCommitment: spend.ksCommitment,
      words: decodeProofWords(spend.proof),
    }),
    "payout",
  );
  await updatePayout(rec.n, { spentInto: ksNote.n });

  onStage("waiting");
  const from = await provider.getBlockNumber();
  const until = Date.now() + WAIT_MS;
  let block: number | null = null;
  while (block === null && Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    block = await findLeafBlock(provider, SHIELD_POOL, ksCommitment, from - 5, poolInserts(substrate(), SHIELD_POOL));
  }
  if (block === null) throw new Error("no one has submitted the payout yet. It stays posted for an hour");

  onStage("settling");
  const [path] = await notePathsAt(provider, SHIELD_POOL, block, [ksCommitment], poolInserts(substrate(), SHIELD_POOL));
  await settleNotes(new Map([[ksNote.n, path]]));
  onStage("done");
}

/** The eight words inside an ABI-encoded (uint256[2], uint256[4], uint256[2]). */
function decodeProofWords(encoded: string): string[] {
  const body = encoded.slice(2);
  return Array.from({ length: 8 }, (_, i) => BigInt("0x" + body.slice(64 * i, 64 * (i + 1))).toString());
}
