// Telling the chosen driver where to go (docs/IMPROVEMENTS.md §0).
//
// Everything else in this design keeps the drop off the record: the order holds
// Poseidon(lat, lon, salt), the coarse area is opt-in and a kilometre wide, and
// the proof at the door opens the commitment without ever naming a place. All
// of which left one hole big enough to walk through — the driver had no idea
// which door. The proof worked; the delivery did not.
//
// So when a bid is accepted, the customer sends the exact drop to the winning
// driver, and to nobody else. It goes sealed on the pair thread the two already
// share, which means it is readable by exactly one key, and the chain, the
// venue, the other bidders and the Statement Store see no more than before.
//
// What this costs, plainly: the driver learns an address. There is no way to
// deliver to a place without knowing the place, so the question was never
// whether to reveal it but to whom and when — one driver, once it has the job.
// What protects the customer is the rest of the design: the order was placed by
// a burner, so the driver learns a doorstep and not a person, and the next
// order uses a different account.
//
// It is sent automatically. A driver standing in the street with no address is
// a failed delivery, and "did you remember to send it" is not a design.

import { concat, getBytes, keccak256, toUtf8Bytes } from "ethers";
import { publishStatement, subscribeTopics } from "../market/statements";
import { sideChannel, threadTopic } from "./chat";
import { open, seal, type Reader } from "./seal";
import type { Position } from "./geo";

const DROP = 13;
const VERSION = 1;

/** Long enough to outlive any order; a statement always carries an expiry (§6.2). */
const KEEP_S = 12 * 3600;

/** Version, kind, the order, then the position. 18 bytes, before sealing. */
export function encodeDrop(orderId: bigint, at: Position): Uint8Array {
  const out = new Uint8Array(18);
  out[0] = VERSION;
  out[1] = DROP;
  let v = orderId;
  for (let i = 9; i >= 2; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  const put = (offset: number, micro: number) => {
    const u = BigInt.asUintN(32, BigInt(micro));
    for (let i = 3; i >= 0; i--)
      out[offset + i] = Number((u >> BigInt((3 - i) * 8)) & 0xffn);
  };
  put(10, at.lat);
  put(14, at.lon);
  return out;
}

export function decodeDrop(
  bytes: Uint8Array
): { orderId: bigint; at: Position } | null {
  if (bytes.length !== 18 || bytes[0] !== VERSION || bytes[1] !== DROP)
    return null;
  let orderId = 0n;
  for (let i = 2; i < 10; i++) orderId = (orderId << 8n) | BigInt(bytes[i]);
  const read = (offset: number) => {
    let v = 0n;
    for (let i = 0; i < 4; i++) v = (v << 8n) | BigInt(bytes[offset + i]);
    return Number(BigInt.asIntN(32, v));
  };
  const at = { lat: read(10), lon: read(14) };
  if (Math.abs(at.lat) > 90_000_000 || Math.abs(at.lon) > 180_000_000)
    return null;
  return { orderId, at };
}

/** One slot per order, so sending it again replaces rather than accumulates. */
const dropChannel = (topic: string, mine: Reader, orderId: bigint): string =>
  keccak256(
    concat([
      toUtf8Bytes("porterage:drop"),
      getBytes(sideChannel(topic, mine.signingKey)),
      encodeDrop(orderId, { lat: 0, lon: 0 }).slice(2, 10),
    ])
  );

/**
 * Send the drop to the driver that won the order. Safe to call again: the same
 * channel is replaced, so a customer reopening the screen costs nothing and a
 * driver that missed it the first time still gets it.
 */
export async function sendDrop(
  mine: Reader,
  driverKey: string,
  orderId: bigint,
  at: Position
): Promise<void> {
  const topic = threadTopic(mine.signingKey, driverKey);
  await publishStatement(
    topic,
    dropChannel(topic, mine, orderId),
    await seal(driverKey, DROP, encodeDrop(orderId, at)),
    KEEP_S
  );
}

/** Watch for the drop on an order this driver has won. */
export function watchDrop(
  mine: Reader,
  customerKey: string,
  orderId: bigint,
  heard: (at: Position) => void
): Promise<() => void> {
  const topic = threadTopic(mine.signingKey, customerKey);
  return subscribeTopics([topic], async (bytes) => {
    const plain = await open(mine, DROP, bytes);
    const read = plain && decodeDrop(plain);
    if (read && read.orderId === orderId) heard(read.at);
  });
}
