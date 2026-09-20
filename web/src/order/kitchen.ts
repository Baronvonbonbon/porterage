// What the counter is making (docs/PLAN.md §4, §6.1).
//
// The order on-chain says which venue and how much, never what. The basket
// travels to the venue sealed on its own topic: the customer seals it to the
// counter's key, which the menu publishes, and only the counter can read it.
//
// So a kitchen sees its own orders and nothing else, and an observer watching
// the Statement Store sees neither the items nor who asked for them.

import { publishStatement, subscribeTopics } from "../market/statements";
import { keccak256, toUtf8Bytes } from "ethers";
import { open, seal, type Reader } from "./seal";
import type { Menu } from "./menu";

const BASKET = 5;

export const venueTopic = (venueId: bigint): string =>
  keccak256(toUtf8Bytes(`porterage:venue:v1:${venueId}`));
export const basketChannel = (orderId: bigint): string =>
  keccak256(toUtf8Bytes(`porterage:basket:${orderId}`));

export interface Basket {
  orderId: bigint;
  /** Menu item id to how many. */
  items: Map<string, number>;
}

/** One byte of order id per line, then each item as its id character and a count. */
export function encodeBasket(b: Basket): Uint8Array {
  const entries = [...b.items].filter(([, n]) => n > 0);
  const out = new Uint8Array(8 + entries.length * 2);
  let v = b.orderId;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  entries.forEach(([id, n], i) => {
    out[8 + i * 2] = id.charCodeAt(0);
    out[9 + i * 2] = Math.min(255, n);
  });
  return out;
}

export function decodeBasket(bytes: Uint8Array): Basket | null {
  if (bytes.length < 8 || (bytes.length - 8) % 2 !== 0) return null;
  let orderId = 0n;
  for (let i = 0; i < 8; i++) orderId = (orderId << 8n) | BigInt(bytes[i]);
  const items = new Map<string, number>();
  for (let i = 8; i < bytes.length; i += 2)
    items.set(String.fromCharCode(bytes[i]), bytes[i + 1]);
  return { orderId, items };
}

/** Send the basket to the counter. The customer does this from the order's own account. */
export async function sendBasket(
  venueId: bigint,
  counterKey: string,
  basket: Basket
): Promise<void> {
  await publishStatement(
    venueTopic(venueId),
    basketChannel(basket.orderId),
    await seal(counterKey, BASKET, encodeBasket(basket))
  );
}

/** Watch this venue's topic. Only baskets sealed to the counter's key open. */
export async function watchBaskets(
  counter: Reader,
  venueId: bigint,
  heard: (b: Basket) => void
): Promise<() => void> {
  return subscribeTopics([venueTopic(venueId)], async (bytes) => {
    const plain = await open(counter, BASKET, bytes);
    const basket = plain && decodeBasket(plain);
    if (basket) heard(basket);
  });
}

/** The basket as a line of text, for the counter to read off. */
export const basketLine = (menu: Menu | null, basket: Basket): string =>
  [...basket.items]
    .filter(([, n]) => n > 0)
    .map(
      ([id, n]) => `${n}× ${menu?.items.find((i) => i.id === id)?.name ?? id}`
    )
    .join(", ");
