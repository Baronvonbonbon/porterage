// Funding requests over the host's Statement Store (docs/PLAN.md §6.2).
//
// A request is signed by the product's statement allowance account, not the
// user's account, so it doesn't name the customer. It goes on one channel per
// requester (a new request replaces the last) with an hour's expiry: without an
// expiry the store keeps a statement forever and the account fills and locks
// (polkadot-host-capabilities, statement-store.md).

import {
  createProofAuthorized,
  formatHostError,
  getStatementStore,
  requestResourceAllocation,
} from "@parity/product-sdk-host";
import { getBytes, hexlify } from "ethers";
import { withTimeout } from "../host";
import {
  CLAIM_TOPIC,
  CLAIM_TTL_S,
  claimChannel,
  decodeClaim,
  encodeClaim,
  type Claims,
} from "./auction";
import {
  FUND_CHANNEL,
  FUND_TOPIC,
  PAYOUT_BYTES,
  PAYOUT_CHANNEL,
  PAYOUT_TOPIC,
  REQUEST_BYTES,
  decodePayout,
  decodeRequest,
  type FundRequest,
  type PayoutRequest,
} from "./request";

const EXPIRY_S = 3600;
const SUBMIT_MS = 60_000;

let sequence = 0;
const expiryIn = (seconds: number) =>
  (BigInt(Math.floor(Date.now() / 1000) + seconds) << 32n) |
  BigInt(++sequence & 0xffff);

let allowance: Promise<unknown> | null = null;

/**
 * Publish one statement. Always with an expiry and a channel: without an expiry
 * the store keeps a statement forever and the account fills and locks, and the
 * channel is what lets a later statement replace an earlier one
 * (polkadot-host-capabilities, statement-store.md).
 */
export async function publishStatement(
  topic: string,
  channel: string,
  bytes: Uint8Array,
  ttlSeconds = EXPIRY_S
): Promise<void> {
  const store = await getStatementStore();
  if (!store)
    throw new Error("the Polkadot app offers no Statement Store here");
  allowance ??= requestResourceAllocation([
    { tag: "StatementStoreAllowance" },
  ] as never).catch(() => (allowance = null));
  await allowance;
  const statement = {
    topics: [topic],
    channel,
    expiry: expiryIn(ttlSeconds),
    data: hexlify(bytes),
  };
  const proof = await withTimeout(
    createProofAuthorized(statement as never),
    SUBMIT_MS,
    "signing the request"
  );
  if (!proof.ok)
    throw new Error(
      `the request couldn't be signed: ${formatHostError(proof.error)}`
    );
  await withTimeout(
    store.submit({ ...statement, proof: proof.value } as never),
    SUBMIT_MS,
    "posting the request"
  );
}

/** Publish a funding or payout request on the market's own topic. */
export function publishRequest(
  bytes: Uint8Array,
  kind: "fund" | "payout" = "fund"
): Promise<void> {
  return publishStatement(
    kind === "fund" ? FUND_TOPIC : PAYOUT_TOPIC,
    kind === "fund" ? FUND_CHANNEL : PAYOUT_CHANNEL,
    bytes
  );
}

/**
 * Say "mine" before sending, so two submitters don't both pay gas for the same
 * job and one of them lose it all to a revert. Short-lived by design: a
 * submitter that claims and then quits frees the job in CLAIM_TTL_S.
 */
export function publishClaim(key: string, claimant: string): Promise<void> {
  return publishStatement(
    CLAIM_TOPIC,
    claimChannel(key, claimant),
    encodeClaim({ key, claimant }),
    CLAIM_TTL_S
  );
}

/** Keep a `Claims` fed from the claim topic. */
export async function subscribeClaims(into: Claims): Promise<() => void> {
  return subscribeTopics([CLAIM_TOPIC], (bytes) => {
    const c = decodeClaim(bytes);
    if (c) into.heard(c);
  });
}

/** Every statement on `topics`, as raw bytes, including ones posted before subscribing. */
export async function subscribeTopics(
  topics: string[],
  heard: (bytes: Uint8Array, topic: string) => void
): Promise<() => void> {
  const store = await getStatementStore();
  if (!store)
    throw new Error("the Polkadot app offers no Statement Store here");
  const sub = store.subscribe(
    { matchAny: topics as `0x${string}`[] },
    (page) => {
      for (const s of (
        page as { statements: { data?: string; topics?: string[] }[] }
      ).statements) {
        if (!s.data) continue;
        try {
          heard(getBytes(s.data), s.topics?.[0] ?? "");
        } catch {
          /* malformed: ignore */
        }
      }
    }
  );
  return () => sub.unsubscribe();
}

/** Calls back for every request on the market, including ones posted before subscribing. */
export async function subscribeRequests(heard: {
  fund?: (r: FundRequest) => void;
  payout?: (r: PayoutRequest) => void;
}): Promise<() => void> {
  const store = await getStatementStore();
  if (!store)
    throw new Error("the Polkadot app offers no Statement Store here");
  const sub = store.subscribe(
    { matchAny: [FUND_TOPIC as `0x${string}`, PAYOUT_TOPIC as `0x${string}`] },
    (page) => {
      for (const s of (page as { statements: { data?: string }[] })
        .statements) {
        if (!s.data) continue;
        const bytes = getBytes(s.data);
        try {
          if (bytes.length === REQUEST_BYTES)
            heard.fund?.(decodeRequest(bytes));
          else if (bytes.length === PAYOUT_BYTES)
            heard.payout?.(decodePayout(bytes));
        } catch {
          /* not ours, or malformed: ignore */
        }
      }
    }
  );
  return () => sub.unsubscribe();
}
