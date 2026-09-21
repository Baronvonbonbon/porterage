// Is the funding market actually working right now?
//
// This is the question nobody could answer. The design leans on strangers
// submitting other people's withdrawals: a customer posts a request and waits
// up to fifteen minutes for someone online to take it. When that does not
// happen the app says "no one has submitted the request yet", which is true and
// useless — it does not say whether nobody is running a helper, whether the fee
// is too low for the ones who are, or whether this particular request is bad.
//
// So: watch both sides. Requests go up on the Statement Store; submissions land
// as `Withdrawal` events on the pool, and the transaction that carried one
// names its submitter. Matching them gives the three numbers that matter —
// how many requests are waiting, how long they have been waiting, and how many
// distinct people cleared anything recently.
//
// WHAT THIS IS NOT. It is not a leak. Everything here is already public: the
// requests are broadcast to everyone by design, and the withdrawals are on
// chain. Reading them together tells an operator whether their market has
// participants; it tells them nothing about who any customer is, because the
// recipient of a withdrawal is a burner and that is the entire point of it.

import { formatEther, keccak256, toUtf8Bytes } from "ethers";
import { SHIELD_POOL } from "../config";
import { ethProvider } from "../contracts";
import { feeNow } from "../market/request";
import { subscribeRequests } from "../market/statements";

/** Kusama Shield's Withdrawal(address,uint256,address,uint256). */
const WITHDRAWAL_TOPIC = keccak256(
  toUtf8Bytes("Withdrawal(address,uint256,address,uint256)")
);

export interface Posted {
  /** The burner the proof pays, which is how a request is matched to its clearing. */
  recipient: string;
  amount: bigint;
  /** When this device first saw the request. */
  seenAt: number;
  /** What it is offering right now, as the price climbs. */
  offering: bigint;
  /** Set once a submission for this recipient is seen on chain. */
  clearedAt?: number;
  clearedBy?: string;
}

export interface Health {
  /** Requests this device has seen and not yet seen cleared. */
  waiting: Posted[];
  /** Cleared in the window, newest first. */
  cleared: Posted[];
  /** Distinct addresses that submitted anything in the window. */
  submitters: string[];
  /** Seconds between posting and clearing, median. Null with nothing to go on. */
  medianWaitS: number | null;
  /** The longest a request has been waiting, right now. */
  oldestWaitingS: number | null;
}

const WINDOW_MS = 60 * 60_000;

export function emptyHealth(): Health {
  return {
    waiting: [],
    cleared: [],
    submitters: [],
    medianWaitS: null,
    oldestWaitingS: null,
  };
}

/**
 * Watch the market. Calls back whenever the picture changes.
 *
 * Requests arrive by subscription; clearings are polled, because a `Withdrawal`
 * is an ordinary log and this is a screen someone has open rather than a hot
 * path. Every ten seconds is plenty for a question measured in minutes.
 */
export async function watchMarket(
  onChange: (h: Health) => void,
  pollMs = 10_000
): Promise<() => void> {
  const seen = new Map<string, Posted>();
  let stopped = false;

  const emit = () => {
    const now = Date.now();
    for (const [key, p] of seen)
      if (now - p.seenAt > WINDOW_MS && p.clearedAt) seen.delete(key);
    const all = [...seen.values()];
    const waiting = all.filter((p) => !p.clearedAt);
    const cleared = all
      .filter((p) => p.clearedAt)
      .sort((a, b) => b.clearedAt! - a.clearedAt!);
    const waits = cleared
      .map((p) => (p.clearedAt! - p.seenAt) / 1000)
      .sort((a, b) => a - b);
    onChange({
      waiting: waiting.sort((a, b) => a.seenAt - b.seenAt),
      cleared,
      submitters: [
        ...new Set(cleared.map((p) => p.clearedBy!).filter(Boolean)),
      ],
      medianWaitS: waits.length ? waits[Math.floor(waits.length / 2)] : null,
      oldestWaitingS: waiting.length
        ? Math.round((now - Math.min(...waiting.map((p) => p.seenAt))) / 1000)
        : null,
    });
  };

  const stopRequests = await subscribeRequests({
    fund: (req) => {
      const key = req.proof.recipient.toLowerCase();
      if (seen.has(key)) return;
      seen.set(key, {
        recipient: req.proof.recipient,
        amount: req.withdrawn,
        seenAt: Date.now(),
        offering: feeNow(req),
      });
      emit();
    },
  }).catch(() => () => undefined);

  const provider = ethProvider();
  let from = await provider.getBlockNumber().catch(() => 0);

  const tick = async () => {
    if (stopped) return;
    try {
      const head = await provider.getBlockNumber();
      if (head >= from) {
        const logs = await provider.getLogs({
          address: SHIELD_POOL,
          topics: [WITHDRAWAL_TOPIC],
          fromBlock: Math.max(0, from - 5),
          toBlock: head,
        });
        for (const l of logs) {
          if (l.topics.length !== 3) continue;
          const recipient = ("0x" + l.topics[2].slice(26)).toLowerCase();
          const p = seen.get(recipient);
          if (!p || p.clearedAt) continue;
          p.clearedAt = Date.now();
          p.clearedBy =
            (await provider.getTransaction(l.transactionHash))?.from ??
            undefined;
        }
        from = head + 1;
      }
    } catch {
      /* a poll that fails is not worth telling anyone about; try again */
    }
    emit();
    if (!stopped) setTimeout(tick, pollMs);
  };
  tick();

  return () => {
    stopped = true;
    stopRequests();
  };
}

/** How the picture reads to someone trying to work out if it is broken. */
export function verdict(h: Health): { tone: string; text: string } {
  if (!h.waiting.length && !h.cleared.length)
    return {
      tone: "muted",
      text: "Nothing has been posted while this screen has been open. That says nothing either way.",
    };
  if (!h.cleared.length && h.waiting.length)
    return {
      tone: "error",
      text:
        `${h.waiting.length} request${h.waiting.length > 1 ? "s" : ""} posted ` +
        `and none cleared. Either nobody is running a helper, or the price ` +
        `isn't covering their gas.`,
    };
  if (h.oldestWaitingS !== null && h.oldestWaitingS > 120)
    return {
      tone: "warn",
      text:
        `Something has been waiting ${h.oldestWaitingS} s while others ` +
        `cleared. That one is probably being refused, not ignored.`,
    };
  return {
    tone: "ok",
    text:
      `${h.cleared.length} cleared, ${h.submitters.length} distinct ` +
      `submitter${h.submitters.length === 1 ? "" : "s"}` +
      (h.medianWaitS !== null ? `, typically ${h.medianWaitS.toFixed(0)} s` : "") +
      ".",
  };
}

export const describeAmount = (wei: bigint): string =>
  `${formatEther(wei)} PAS`;
