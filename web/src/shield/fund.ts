// Funding a fresh burner from the private balance (docs/PLAN.md §5.3–5.4).
//
//   1. pick one note that covers the amount plus the submitter's tip
//   2. prove a withdrawal of that much to the burner; the rest becomes a change note
//   3. post the proof as a funding request; any online participant submits it
//   4. when the burner is funded: mark the note spent, find and record the change
//      note, and tip whoever submitted it, from the burner
//
// Nothing here is signed by the user's account: the proof is made on the phone,
// the request is signed by the product's statement account, the withdrawal by a
// stranger, and the tip by the burner.

import { Wallet, ZeroAddress, formatEther, zeroPadValue } from "ethers";
import { SHIELD_POOL } from "../config";
import { ethProvider } from "../contracts";
import { substrate } from "../hostchain";
import { burner as burnerKey } from "../keys";
import { encodeRequest } from "../market/request";
import { publishRequest } from "../market/statements";
import { poolInserts } from "./events";
import { commitmentOf, findLeafBlock, notePathsAt } from "./pool";
import { allNotes, markSpending, markSpent, nextBurner, noteOf, reserveNotes, settleNotes, spendable, type NoteRecord } from "./notes";
import { proveWithdrawal } from "./withdraw";

/** What a submitter is offered: about ten times a withdrawal's gas at Paseo prices. */
export const DEFAULT_TIP = 3n * 10n ** 17n; // 0.3 PAS
const POLL_MS = 4_000;
const WAIT_MS = 15 * 60_000;

export type FundStage = "proving" | "posting" | "waiting" | "settling" | "tipping" | "done";

export interface Funded {
  burner: Wallet;
  burnerIndex: number;
  received: bigint;
  submitter: string | null;
  tipped: boolean;
}

const inserts = () => poolInserts(substrate(), SHIELD_POOL);

export async function fundBurner(amount: bigint, onStage: (s: FundStage) => void, tip = DEFAULT_TIP): Promise<Funded> {
  const need = amount + tip;
  const note = (await spendable()).find((r) => BigInt(r.value) >= need);
  if (!note) throw new Error(`no single note holds ${formatEther(need)} PAS; shield more first`);

  const burnerIndex = await nextBurner();
  const burner = (await burnerKey(burnerIndex)).connect(ethProvider());
  const [change] = await reserveNotes([BigInt(note.value) - need]);
  const provider = ethProvider();
  const startBlock = await provider.getBlockNumber();

  onStage("proving");
  const proof = await proveWithdrawal({
    provider,
    pool: SHIELD_POOL,
    note: await noteOf(note),
    path: note.path!,
    change: await noteOf(change),
    recipient: burner.address,
    withdrawnValue: need,
    fromSubstrate: inserts(),
  });

  onStage("posting");
  await publishRequest(encodeRequest({ proof, withdrawn: need, fee: tip }));
  await markSpending(note.n, { burner: burnerIndex, change: change.n, since: Date.now(), tip: tip.toString() });

  onStage("waiting");
  const received = await waitForFunds(burner.address, need);
  return finish(note, change, burner, burnerIndex, received, startBlock, tip, onStage);
}

async function waitForFunds(address: string, need: bigint): Promise<bigint> {
  const provider = ethProvider();
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    const bal = await provider.getBalance(address);
    if (bal >= need) return bal;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error("no one has submitted the request yet. It stays posted for an hour; try again later");
}

async function finish(
  note: NoteRecord,
  change: NoteRecord,
  burner: Wallet,
  burnerIndex: number,
  received: bigint,
  startBlock: number,
  tip: bigint,
  onStage: (s: FundStage) => void,
): Promise<Funded> {
  const provider = ethProvider();
  onStage("settling");
  await markSpent(note.n);
  const changeCommit = commitmentOf(await noteOf(change));
  const block = await findLeafBlock(provider, SHIELD_POOL, changeCommit, startBlock, inserts());
  if (block !== null) {
    const [path] = await notePathsAt(provider, SHIELD_POOL, block, [changeCommit], inserts());
    await settleNotes(new Map([[change.n, path]]));
  }

  // The withdrawal event names the recipient; its transaction names the submitter.
  onStage("tipping");
  let submitter: string | null = null;
  const logs = await provider.getLogs({
    address: SHIELD_POOL,
    topics: [null, null, zeroPadValue(burner.address, 32)],
    fromBlock: startBlock,
    toBlock: "latest",
  });
  if (logs.length) submitter = (await provider.getTransaction(logs[0].transactionHash))?.from ?? null;
  let tipped = false;
  if (submitter && submitter !== ZeroAddress) {
    const tx = await burner.sendTransaction({ to: submitter, value: tip });
    await tx.wait().catch(() => undefined);
    tipped = true;
  }
  onStage("done");
  return { burner, burnerIndex, received, submitter, tipped };
}

const REQUEST_LIFETIME_MS = 60 * 60_000;

/**
 * Pick up funding requests left over from an earlier session: finish the ones
 * whose burner was funded, and release the note of any whose request expired
 * unanswered (the note was never spent, so it's usable again).
 */
export async function resumeFunding(): Promise<Funded[]> {
  const done: Funded[] = [];
  const provider = ethProvider();
  for (const note of (await allNotes()).filter((r) => r.spending && !r.spent)) {
    const s = note.spending!;
    const burner = (await burnerKey(s.burner)).connect(provider);
    const change = (await allNotes()).find((r) => r.n === s.change);
    const tip = BigInt(s.tip);
    const need = BigInt(note.value) - BigInt(change?.value ?? "0");
    const bal = await provider.getBalance(burner.address);
    if (bal >= need && change) {
      // Search from a little before the request: blocks are about 6 s apart.
      const head = await provider.getBlockNumber();
      const from = Math.max(0, head - Math.ceil((Date.now() - s.since) / 6000) - 20);
      done.push(await finish(note, change, burner, s.burner, bal, from, tip, () => {}));
    } else if (Date.now() - s.since > REQUEST_LIFETIME_MS) {
      await markSpending(note.n, undefined);
    }
  }
  return done;
}
