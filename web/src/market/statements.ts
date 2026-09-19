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
import { FUND_CHANNEL, FUND_TOPIC, REQUEST_BYTES, decodeRequest, type FundRequest } from "./request";

const EXPIRY_S = 3600;
const SUBMIT_MS = 60_000;

let sequence = 0;
const expiryIn = (seconds: number) =>
  (BigInt(Math.floor(Date.now() / 1000) + seconds) << 32n) | BigInt(++sequence & 0xffff);

let allowance: Promise<unknown> | null = null;

export async function publishRequest(bytes: Uint8Array): Promise<void> {
  const store = await getStatementStore();
  if (!store) throw new Error("the Polkadot app offers no Statement Store here");
  allowance ??= requestResourceAllocation([{ tag: "StatementStoreAllowance" }] as never).catch(() => (allowance = null));
  await allowance;
  const statement = { topics: [FUND_TOPIC], channel: FUND_CHANNEL, expiry: expiryIn(EXPIRY_S), data: hexlify(bytes) };
  const proof = await withTimeout(createProofAuthorized(statement as never), SUBMIT_MS, "signing the request");
  if (!proof.ok) throw new Error(`the request couldn't be signed: ${formatHostError(proof.error)}`);
  await withTimeout(store.submit({ ...statement, proof: proof.value } as never), SUBMIT_MS, "posting the request");
}

/** Calls `heard` for every funding request, including ones posted before subscribing. */
export async function subscribeRequests(heard: (r: FundRequest) => void): Promise<() => void> {
  const store = await getStatementStore();
  if (!store) throw new Error("the Polkadot app offers no Statement Store here");
  const sub = store.subscribe({ matchAny: [FUND_TOPIC as `0x${string}`] }, (page) => {
    for (const s of (page as { statements: { data?: string }[] }).statements) {
      if (!s.data) continue;
      const bytes = getBytes(s.data);
      if (bytes.length !== REQUEST_BYTES) continue;
      try {
        heard(decodeRequest(bytes));
      } catch {
        /* not ours, or malformed: ignore */
      }
    }
  });
  return () => sub.unsubscribe();
}
