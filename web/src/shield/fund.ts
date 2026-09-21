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

import {
  Wallet,
  ZeroAddress,
  formatEther,
  keccak256,
  toUtf8Bytes,
  zeroPadValue,
} from "ethers";
import { Contract } from "ethers";
import { SHIELD_POOL } from "../config";
import { addressOf, ethProvider, writable } from "../contracts";
import {
  WITHDRAW_GAS,
  nowSeconds,
  priceAt,
  scheduleFor,
  type Schedule,
} from "../market/auction";
import { substrate } from "../hostchain";
import { burner as burnerKey } from "../keys";
import { encodeRequest } from "../market/request";
import { publishRequest } from "../market/statements";
import { poolInserts } from "./events";
import { commitmentOf, findLeafBlock, notePathsAt } from "./pool";
import {
  allNotes,
  markSpending,
  markSpent,
  nextBurner,
  noteOf,
  reserveNotes,
  settleNotes,
  spendable,
  type NoteRecord,
} from "./notes";
import { proveWithdrawal } from "./withdraw";

const POLL_MS = 4_000;
const WAIT_MS = 15 * 60_000;

/**
 * What the withdrawal is expected to cost in gas, priced now. The number the
 * whole auction hangs off: floor is 1.5x it, ceiling 4x.
 *
 * WHY THIS IS NOT AN `estimateGas` CALL, which is the obvious thing to reach
 * for. Estimating needs a valid proof; the proof commits to the withdrawn
 * amount; the amount is `what you asked for + the ceiling`; and the ceiling is
 * what we are trying to work out. It is a circle, and the way out of it is to
 * notice that the gas UNITS here are not variable: `pool.withdraw` verifies a
 * Groth16 proof over a fixed circuit and walks a fixed-depth tree, so it costs
 * essentially the same whatever the note holds. The volatile half is the gas
 * PRICE, and that is read live on every request.
 *
 * The submitter still estimates for real (`market/submit.ts`) — it has the
 * finished proof by then, and its estimate doubles as the validity check. So a
 * requester that guesses the units slightly high or low is corrected by a
 * market that prices its own costs honestly.
 */
async function gasCostNow(): Promise<bigint> {
  const price = (await ethProvider().getFeeData()).gasPrice ?? 10n ** 12n;
  return WITHDRAW_GAS * price;
}

export type FundStage =
  | "proving"
  | "posting"
  | "waiting"
  | "settling"
  | "tipping"
  | "done";

export interface Funded {
  burner: Wallet;
  burnerIndex: number;
  received: bigint;
  submitter: string | null;
  tipped: boolean;
  /** What the auction actually cleared at, once a submitter has been paid. */
  fee?: bigint | null;
}

const inserts = () => poolInserts(substrate(), SHIELD_POOL);

/** Kusama Shield's `Withdrawal(address indexed asset, uint256 value, address indexed recipient, uint256)`. */
const WITHDRAWAL_TOPIC = keccak256(
  toUtf8Bytes("Withdrawal(address,uint256,address,uint256)")
);

/**
 * Who submitted the withdrawal that funded `recipient`, from the pool's own
 * event. Only the FIRST topic may be filtered on Paseo: a `null` placeholder is
 * refused outright ("data did not match any variant of untagged enum
 * FilterTopic", 2026-09-20), so the recipient is matched here instead.
 */
async function submissionOf(
  recipient: string,
  fromBlock: number
): Promise<{ submitter: string; at: number } | null> {
  const provider = ethProvider();
  const want = zeroPadValue(recipient, 32).toLowerCase();
  const logs = await provider.getLogs({
    address: SHIELD_POOL,
    topics: [WITHDRAWAL_TOPIC],
    fromBlock,
    toBlock: "latest",
  });
  const hit = logs.find(
    (l) => l.topics.length === 3 && l.topics[2].toLowerCase() === want
  );
  if (!hit) return null;
  const from =
    (await provider.getTransaction(hit.transactionHash))?.from ?? null;
  if (!from || from === ZeroAddress) return null;
  // The chain's clock, not this device's: the price is what the schedule said
  // at the moment the submission actually landed.
  const block = await provider.getBlock(hit.blockNumber);
  return { submitter: from, at: block?.timestamp ?? nowSeconds() };
}

/**
 * Pay the submitter, from the burner. A fee that can't be paid yet — the
 * withdrawal came from a Substrate account, or the burner is short — is left for
 * `resumeFunding` rather than failing a funding that has already worked.
 *
 * TWO THINGS WORTH READING SLOWLY.
 *
 * The price is read from the CHAIN'S clock, not this device's: `priceAt` is
 * evaluated at the timestamp of the block that carried the submission. A
 * submitter is paid for when it actually landed the transaction, and a
 * requester whose phone clock is slow or fast cannot underpay or overpay by
 * accident. It is capped at the ceiling either way.
 *
 * The fee is paid INTO THE VAULT, not to the submitter's address. A plain
 * transfer accumulates at an address in amounts that say how much work someone
 * did — and for a driver running the funding helper, `PorterDrivers.actsFor`
 * already ties that address to them publicly. Crediting the vault instead lets
 * a submitter's fee income shield through `insertShieldNote` exactly like a
 * fare or a venue's takings. This is the last clear-value rail in the design,
 * and this line is where it closes.
 */
async function payFee(
  burner: Wallet,
  sched: Schedule,
  fromBlock: number
): Promise<{ submitter: string; fee: bigint } | null> {
  const hit = await submissionOf(burner.address, fromBlock);
  if (!hit) return null;
  const fee = priceAt(sched, hit.at);
  const vault = new Contract(
    addressOf("vault"),
    ["function tip(address payee) payable"],
    writable(burner)
  );
  const tx = await vault.tip(hit.submitter, { value: fee });
  await tx.wait().catch(() => undefined);
  return { submitter: hit.submitter, fee };
}

export async function fundBurner(
  amount: bigint,
  onStage: (s: FundStage) => void
): Promise<Funded> {
  const burnerIndex = await nextBurner();
  const burner = (await burnerKey(burnerIndex)).connect(ethProvider());
  const provider = ethProvider();

  // The CEILING is what gets reserved out of the note, because at proving time
  // nobody knows what the job will actually clear at. The difference between
  // the ceiling and the price paid is not lost: it stays with the burner, where
  // it pays that burner's own gas.
  onStage("proving");
  const sched = scheduleFor(await gasCostNow());
  const need = amount + sched.ceiling;

  const note = (await spendable()).find((r) => BigInt(r.value) >= need);
  if (!note)
    throw new Error(
      `no single note holds ${formatEther(need)} PAS; shield more first`
    );
  const [change] = await reserveNotes([BigInt(note.value) - need]);
  const startBlock = await provider.getBlockNumber();

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
  // The clock starts when the request is posted, not when proving began: a
  // seven-second proof should not have already eaten a quarter of the climb.
  const schedule = { ...sched, startedAt: nowSeconds() };
  await publishRequest(encodeRequest({ proof, withdrawn: need, schedule }));
  await markSpending(note.n, {
    burner: burnerIndex,
    change: change.n,
    since: Date.now(),
    tip: schedule.ceiling.toString(),
    schedule: {
      floor: schedule.floor.toString(),
      ceiling: schedule.ceiling.toString(),
      startedAt: schedule.startedAt,
      climbSecs: schedule.climbSecs,
    },
  });

  onStage("waiting");
  const received = await waitForFunds(burner.address, need);
  return finish(
    note,
    change,
    burner,
    burnerIndex,
    received,
    startBlock,
    schedule,
    onStage
  );
}

async function waitForFunds(address: string, need: bigint): Promise<bigint> {
  const provider = ethProvider();
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    const bal = await provider.getBalance(address);
    if (bal >= need) return bal;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(
    "no one has submitted the request yet. It stays posted for an hour; try again later"
  );
}

async function finish(
  note: NoteRecord,
  change: NoteRecord,
  burner: Wallet,
  burnerIndex: number,
  received: bigint,
  startBlock: number,
  sched: Schedule,
  onStage: (s: FundStage) => void
): Promise<Funded> {
  const provider = ethProvider();
  onStage("settling");
  await markSpent(note.n);
  const changeCommit = commitmentOf(await noteOf(change));
  const block = await findLeafBlock(
    provider,
    SHIELD_POOL,
    changeCommit,
    startBlock,
    inserts()
  );
  if (block !== null) {
    const [path] = await notePathsAt(
      provider,
      SHIELD_POOL,
      block,
      [changeCommit],
      inserts()
    );
    await settleNotes(new Map([[change.n, path]]));
  }

  // The withdrawal event names the recipient; its transaction names the submitter.
  onStage("tipping");
  let paid: { submitter: string; fee: bigint } | null = null;
  try {
    paid = await payFee(burner, sched, startBlock);
  } catch {
    paid = null; // retried by resumeFunding
  }
  await markSpending(note.n, {
    burner: burnerIndex,
    change: change.n,
    since: Date.now(),
    tip: sched.ceiling.toString(),
    schedule: {
      floor: sched.floor.toString(),
      ceiling: sched.ceiling.toString(),
      startedAt: sched.startedAt,
      climbSecs: sched.climbSecs,
    },
    tipped: !!paid,
  });
  onStage("done");
  return {
    burner,
    burnerIndex,
    received,
    submitter: paid?.submitter ?? null,
    tipped: !!paid,
    fee: paid?.fee ?? null,
  };
}

/**
 * The schedule a stored record was published with. Records written before the
 * market existed carry only a flat `tip`; they are paid exactly that, by
 * treating it as a schedule that never moves.
 */
function scheduleOf(s: NonNullable<NoteRecord["spending"]>): Schedule {
  if (!s.schedule)
    return {
      floor: BigInt(s.tip),
      ceiling: BigInt(s.tip),
      startedAt: 0,
      climbSecs: 0,
    };
  return {
    floor: BigInt(s.schedule.floor),
    ceiling: BigInt(s.schedule.ceiling),
    startedAt: s.schedule.startedAt,
    climbSecs: s.schedule.climbSecs,
  };
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
  // Tips that couldn't be paid when the funding finished.
  for (const note of (await allNotes()).filter(
    (r) => r.spent && r.spending && !r.spending.tipped
  )) {
    const s = note.spending!;
    const burner = (await burnerKey(s.burner)).connect(provider);
    const head = await provider.getBlockNumber();
    const from = Math.max(
      0,
      head - Math.ceil((Date.now() - s.since) / 6000) - 20
    );
    try {
      const paid = await payFee(burner, scheduleOf(s), from);
      if (paid) await markSpending(note.n, { ...s, tipped: true });
    } catch {
      /* try again next time */
    }
  }

  for (const note of (await allNotes()).filter((r) => r.spending && !r.spent)) {
    const s = note.spending!;
    const burner = (await burnerKey(s.burner)).connect(provider);
    const change = (await allNotes()).find((r) => r.n === s.change);
    const need = BigInt(note.value) - BigInt(change?.value ?? "0");
    const bal = await provider.getBalance(burner.address);
    if (bal >= need && change) {
      // Search from a little before the request: blocks are about 6 s apart.
      const head = await provider.getBlockNumber();
      const from = Math.max(
        0,
        head - Math.ceil((Date.now() - s.since) / 6000) - 20
      );
      done.push(
        await finish(
          note,
          change,
          burner,
          s.burner,
          bal,
          from,
          scheduleOf(s),
          () => {}
        )
      );
    } else if (Date.now() - s.since > REQUEST_LIFETIME_MS) {
      await markSpending(note.n, undefined);
    }
  }
  return done;
}
