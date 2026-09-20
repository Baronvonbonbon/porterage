// Venue menus (docs/PLAN.md §6.1).
//
// The menu is a small JSON document on Bulletin, and the venue's on-chain
// metadata points at it. Bulletin keeps content for about two weeks, so a venue
// republishes now and then; the pointer only changes when the menu does.
//
// It is public on purpose: customers must read it before they have any account,
// and a menu says nothing about who orders from it.

import { ABI, addressOf } from "../contracts";
import { hostCall } from "../hostchain";
import { hostGet, hostPut } from "../host";

export interface MenuItem {
  /** Short id, kept in the basket rather than the name. */
  id: string;
  name: string;
  /** Price in wei of PAS. */
  price: bigint;
}
export interface Menu {
  name: string;
  items: MenuItem[];
  /** The counter's key, so a customer can seal its basket to it (kitchen.ts). */
  counterKey?: string;
}

const PREFIX = "bulletin:";

export function encodeMenu(menu: Menu): Uint8Array {
  const doc = {
    v: 1,
    name: menu.name,
    items: menu.items.map((i) => ({ id: i.id, n: i.name, p: i.price.toString() })),
    ...(menu.counterKey ? { k: menu.counterKey } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(doc));
}

export function decodeMenu(bytes: Uint8Array): Menu {
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as {
    v: number;
    name: string;
    items: { id: string; n: string; p: string }[];
    k?: string;
  };
  if (doc.v !== 1 || !Array.isArray(doc.items)) throw new Error("not a menu");
  return {
    name: String(doc.name ?? ""),
    items: doc.items.map((i) => ({ id: String(i.id), name: String(i.n), price: BigInt(i.p) })),
    ...(doc.k ? { counterKey: String(doc.k) } : {}),
  };
}

/** Store the menu and point the venue at it. Two taps: the upload, then the pointer. */
export async function publishMenu(venueId: bigint, menu: Menu): Promise<string> {
  const key = await hostPut(encodeMenu(menu));
  const uri = PREFIX + (key.startsWith("0x") ? key.slice(2) : key);
  await hostCall(addressOf("venues"), ABI.venues.encodeFunctionData("setMetadata", [venueId, uri]));
  return uri;
}

/** Read a venue's menu. Null when it has none, or Bulletin has let it go. */
export async function menuOf(metadataURI: string): Promise<Menu | null> {
  if (!metadataURI.startsWith(PREFIX)) return null;
  const bytes = await hostGet(metadataURI.slice(PREFIX.length));
  if (!bytes) return null;
  try {
    return decodeMenu(bytes);
  } catch {
    return null;
  }
}

export const basketTotal = (menu: Menu, picked: Map<string, number>): bigint =>
  menu.items.reduce((total, i) => total + i.price * BigInt(picked.get(i.id) ?? 0), 0n);

/** What the venue sees: the basket as ids and counts, small enough for a statement later. */
export const basketText = (menu: Menu, picked: Map<string, number>): string =>
  menu.items
    .filter((i) => picked.get(i.id))
    .map((i) => `${picked.get(i.id)}× ${i.name}`)
    .join(", ");
