// Sealed bidding (docs/PLAN.md §4 step 2).
//
// A bid is committed on-chain as a hash that names nobody, and its terms travel
// to the customer over the Statement Store, encrypted so only the customer can
// read them. The customer picks any bid, not just the cheapest, and revealing it
// is what assigns the driver.
//
// The encryption is ECDH on the same curve the keys already use: the customer
// publishes the order account's public key, and each bidder encrypts with a
// fresh key of its own, so two bids on different orders don't look like the same
// driver to anyone watching.

import {
  AbiCoder,
  Contract,
  SigningKey,
  Wallet,
  concat,
  getBytes,
  hexlify,
  keccak256,
  toUtf8Bytes,
} from "ethers";

import { ABI, addressOf, read } from "../contracts";
import { publishStatement, subscribeTopics } from "../market/statements";
import { VERSION, open, seal, type Reader } from "./seal";

const ANNOUNCE = 3;
const BID = 4;

/** The public topic for one order's messages. */
export const orderTopic = (orderId: bigint): string =>
  keccak256(toUtf8Bytes(`porterage:order:v1:${orderId}`));
/** The customer's slot on that topic, and each bidder's own. */
export const ANNOUNCE_CHANNEL = keccak256(toUtf8Bytes("porterage:order:key"));
export const bidChannel = (orderId: bigint): string =>
  keccak256(toUtf8Bytes(`porterage:bid:${orderId}`));

// ── the customer's announcement ──────────────────────────────────────────────

/** Tell bidders which key to encrypt to: version, kind, then the compressed public key. */
export function encodeAnnounce(publicKey: string): Uint8Array {
  const key = getBytes(SigningKey.computePublicKey(publicKey, true));
  if (key.length !== 33) throw new Error("expected a compressed public key");
  return getBytes(concat([new Uint8Array([VERSION, ANNOUNCE]), key]));
}

export function decodeAnnounce(b: Uint8Array): string | null {
  if (b.length !== 35 || b[0] !== VERSION || b[1] !== ANNOUNCE) return null;
  return hexlify(b.slice(2));
}

/** Publish the order account's public key, so bidders can reach the customer. */
export function announceOrder(burner: Reader, orderId: bigint): Promise<void> {
  return publishStatement(
    orderTopic(orderId),
    ANNOUNCE_CHANNEL,
    encodeAnnounce(burner.signingKey.publicKey)
  );
}

// ── sealed openings ──────────────────────────────────────────────────────────

export interface BidOpening {
  driver: string;
  amount: bigint;
  salt: string;
}

const openingBytes = (o: BidOpening): Uint8Array =>
  getBytes(concat([o.driver, hexlify(bigToBytes(o.amount, 12)), o.salt]));

function bigToBytes(v: bigint, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("amount too large");
  return out;
}

/** Encrypt an opening to the customer's key, with a throwaway key of our own. */
export const sealOpening = (
  customerKey: string,
  opening: BidOpening
): Promise<Uint8Array> => seal(customerKey, BID, openingBytes(opening));

/** Read an opening addressed to this order account. Null when it isn't one, or isn't ours. */
export async function openSealed(
  burner: Reader,
  bytes: Uint8Array
): Promise<BidOpening | null> {
  const plain = await open(burner, BID, bytes);
  if (!plain || plain.length !== 64) return null;
  let amount = 0n;
  for (const byte of plain.slice(20, 32))
    amount = (amount << 8n) | BigInt(byte);
  return {
    driver: hexlify(plain.slice(0, 20)),
    amount,
    salt: hexlify(plain.slice(32, 64)),
  };
}

// ── the two sides ────────────────────────────────────────────────────────────

export interface Bid extends BidOpening {
  bidHash: string;
  /** The commitment is on-chain and hasn't been retracted. */
  standing: boolean;
}

/**
 * Bid on an order: commit the hash on-chain with the session key (no taps), then
 * send the terms to the customer. `revokeSecret` is kept by the caller, and lets
 * the bid be retracted without naming the bidder.
 */
export async function placeBid(
  sessionKey: Wallet,
  orderId: bigint,
  driver: string,
  amount: bigint,
  customerKey: string
): Promise<{ bidHash: string; salt: string; revokeSecret: string }> {
  const orders = read("orders");
  const salt = hexlify(crypto.getRandomValues(new Uint8Array(32)));
  const revokeSecret = hexlify(crypto.getRandomValues(new Uint8Array(32)));
  const bidHash = (await orders.bidHashOf(
    orderId,
    driver,
    amount,
    salt
  )) as string;
  // PorterOrders checks keccak256(abi.encode(secret)), so encode it the same way.
  const revokeHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(["bytes32"], [revokeSecret])
  );

  const write = new Contract(
    addressOf("orders"),
    ABI.orders.fragments as never,
    sessionKey
  );
  await (await write.commitBid(orderId, bidHash, revokeHash)).wait();
  await publishStatement(
    orderTopic(orderId),
    bidChannel(orderId),
    await sealOpening(customerKey, { driver, amount, salt })
  );
  return { bidHash, salt, revokeSecret };
}

/** Watch one order's topic for bids addressed to this order account. */
export async function watchBids(
  burner: Reader,
  orderId: bigint,
  heard: (bid: Bid) => void
): Promise<() => void> {
  const orders = read("orders");
  return subscribeTopics([orderTopic(orderId)], async (bytes) => {
    const opening = await openSealed(burner, bytes);
    if (!opening) return;
    const bidHash = (await orders.bidHashOf(
      orderId,
      opening.driver,
      opening.amount,
      opening.salt
    )) as string;
    const onChain = await orders.sealedBid(orderId, bidHash);
    heard({
      ...opening,
      bidHash,
      standing: onChain.exists && !onChain.revoked,
    });
  });
}

/**
 * The key a bidder must encrypt to, from the customer's announcement on the
 * order's topic. Statements already posted are delivered to a new subscription,
 * so this finds one placed before the driver joined.
 */
export function customerKeyOf(
  orderId: bigint,
  timeoutMs = 20_000
): Promise<string | null> {
  return new Promise((resolve) => {
    let stop: (() => void) | null = null;
    const finish = (key: string | null) => {
      stop?.();
      clearTimeout(timer);
      resolve(key);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    subscribeTopics([orderTopic(orderId)], (bytes) => {
      const key = decodeAnnounce(bytes);
      if (key) finish(key);
    })
      .then((s) => (stop = s))
      .catch(() => finish(null));
  });
}
