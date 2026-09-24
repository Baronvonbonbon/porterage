// Filing a dispute (docs/PLAN.md §6, Phase 6).
//
// A dispute freezes the order's escrow while an arbiter looks at it, so the
// only moment it can be filed is while the order is in flight — Assigned or
// PickedUp. After settlement the money has already moved, which is why the
// photo at the door is committed on-chain BEFORE a dispute can exist.
//
// What the arbiter is given travels in the dispute's own `evidenceURI`, sealed
// to the arbiter's key: the reason, and the photo's content key. It goes in the
// transaction rather than onto Bulletin on purpose — the burner sends the
// transaction, but a Bulletin write is signed by the phone's host account,
// which would tie this order to the person filing it.
//
// The arbiter can then fetch the photo by the key committed while the order was
// live, check the bytes hash to that commitment, and open them. It never learns
// an identity key: the content key opens this photo and nothing else.

import {
  Contract,
  concat,
  getBytes,
  hexlify,
  toUtf8Bytes,
  toUtf8String,
  type Wallet,
} from "ethers";
import { ABI, addressOf, read, writable } from "../contracts";
import { send } from "../send";
import { hostGet } from "../host";
import { hostCall } from "../hostchain";
import { arbiterKey } from "./arbiter";
import { openWithKey } from "./evidence";
import { open, seal, type Reader } from "./seal";

const CASE = 8;

export const DisputeStatus = { None: 0, Open: 1, Resolved: 2 } as const;

export interface Case {
  /** What the filer says went wrong. */
  reason: string;
  /** The content key of the filer's own photo, when there is one. */
  photoKey?: Uint8Array;
}

/** The reason, then the photo's key if one is enclosed. */
export function encodeCase(c: Case): Uint8Array {
  const reason = toUtf8Bytes(c.reason.slice(0, 200));
  return getBytes(
    concat([
      new Uint8Array([reason.length]),
      reason,
      c.photoKey ?? new Uint8Array(),
    ])
  );
}

export function decodeCase(bytes: Uint8Array): Case | null {
  if (bytes.length < 1) return null;
  const length = bytes[0];
  if (bytes.length < 1 + length) return null;
  const rest = bytes.slice(1 + length);
  if (rest.length !== 0 && rest.length !== 32) return null;
  try {
    return {
      reason: toUtf8String(bytes.slice(1, 1 + length)),
      photoKey: rest.length ? rest : undefined,
    };
  } catch {
    return null;
  }
}

const PREFIX = "porterage:case:1:";

/** The sealed case as the contract stores it, and the bond it asks for. */
async function papers(
  orderId: bigint,
  c: Case
): Promise<{ uri: string; bond: bigint }> {
  const key = await arbiterKey();
  if (!key)
    throw new Error(
      "no arbiter is set, so a dispute would have nobody to read it"
    );
  const sealed = await seal(key, CASE, encodeCase(c));
  return {
    uri: PREFIX + hexlify(sealed).slice(2),
    bond: await read("disputes").disputeBond(),
  };
}

/**
 * File as the customer, from the order's own account. No tap: the burner has
 * its own gas, and the dispute is as unlinked as the order was.
 */
export async function fileDispute(
  burner: Wallet,
  orderId: bigint,
  c: Case
): Promise<{ disputeId: bigint }> {
  const { uri, bond } = await papers(orderId, c);
  const disputes = new Contract(
    addressOf("disputes"),
    ABI.disputes.fragments as never,
    writable(burner)
  );
  await send(() => disputes.openDispute(orderId, uri, { value: bond }));
  return { disputeId: await read("disputes").disputeOfOrder(orderId) };
}

/**
 * File as the driver, which means a tap: the contract asks for a party to the
 * order, and a driver's party is its own account — the session key acts for it
 * in the settlement path, not here.
 */
export async function fileDisputeAsDriver(
  orderId: bigint,
  c: Case
): Promise<{ disputeId: bigint }> {
  const { uri, bond } = await papers(orderId, c);
  await hostCall(
    addressOf("disputes"),
    ABI.disputes.encodeFunctionData("openDispute", [orderId, uri]),
    bond
  );
  return { disputeId: await read("disputes").disputeOfOrder(orderId) };
}

export interface Filed {
  disputeId: bigint;
  orderId: bigint;
  opener: string;
  bond: bigint;
  status: number;
  evidenceURI: string;
}

/** The dispute on an order, or null. */
export async function disputeOf(orderId: bigint): Promise<Filed | null> {
  const disputes = read("disputes");
  const id: bigint = await disputes.disputeOfOrder(orderId);
  if (id === 0n) return null;
  const d = await disputes.disputes(id);
  return {
    disputeId: id,
    orderId: d.orderId,
    opener: d.opener,
    bond: d.bond,
    status: Number(d.status),
    evidenceURI: d.evidenceURI,
  };
}

// ── the arbiter's side ───────────────────────────────────────────────────────

/** Read a filed case. Only the arbiter's key opens it. */
export async function openCase(
  mine: Reader,
  evidenceURI: string
): Promise<Case | null> {
  if (!evidenceURI.startsWith(PREFIX)) return null;
  const plain = await open(
    mine,
    CASE,
    getBytes(`0x${evidenceURI.slice(PREFIX.length)}`)
  );
  return plain && decodeCase(plain);
}

/**
 * Fetch the photo a party committed and open it with the key from the case.
 * Fetching BY the committed key is itself the integrity check: a Bulletin key
 * is the hash of the bytes, so nothing else can come back under it. What the
 * chain adds is the timestamp — that the key was committed while the order was
 * still live, before anyone knew there would be a dispute.
 */
export async function evidenceFor(
  orderId: bigint,
  party: string,
  photoKey: Uint8Array
): Promise<{ photo: Uint8Array; committedAt: number } | null> {
  const e = await read("disputes").evidenceOf(orderId, party);
  const committed = e[0] as string;
  if (!committed || committed === `0x${"0".repeat(64)}`) return null;
  const sealed = await hostGet(committed);
  if (!sealed) return null;
  return {
    photo: await openWithKey(photoKey, sealed),
    committedAt: Number(e[1]),
  };
}
