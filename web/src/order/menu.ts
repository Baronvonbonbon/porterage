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
import { cacheMenu, cachedMenu } from "../shield/notes";
import { cleanLabels, type Label } from "./labels";

export interface MenuItem {
  /** Short id, kept in the basket rather than the name. */
  id: string;
  name: string;
  /** Price in wei of PAS. */
  price: bigint;
  /**
   * The vendor's own heading: "Appetizers", "Drinks", "Sides". FREE TEXT, on
   * purpose, and the opposite of `labels` below. A label is filtered on, so it
   * must come from a fixed vocabulary or "coffee" and "Coffee" become two
   * filters. A section is only ever drawn as a heading on that one venue's own
   * menu, so nobody else has to agree with it and the vendor should be allowed
   * to call its sections whatever it calls them.
   *
   * Section ORDER is the order sections first appear in `items`, so a vendor
   * arranges its menu by arranging its items, with nothing extra to keep in
   * step.
   */
  section?: string;
  /** A line under the name. What it is, not a sales pitch. */
  note?: string;
}

/**
 * A charge the vendor adds on top of the goods: sales tax, VAT, a service
 * charge. Named by the vendor and shown to the customer, itemised, before
 * they pay — a total that appeared from nowhere is how people stop trusting a
 * bill.
 *
 * WHERE THE MONEY GOES: nowhere new. Tax is added to `orderValue`, which is
 * what the venue is owed, and the venue is paid it at pickup along with the
 * rest. The contract has no idea any of this is tax and does not need one;
 * remitting it is the vendor's business, exactly as it is at a till. Giving
 * tax its own on-chain recipient would mean a new party, a new payout and a
 * new thing to get wrong, for no benefit to anybody in this system.
 */
export interface TaxLine {
  /** What it is called on the bill: "State tax", "VAT", "Service". */
  name: string;
  /** Basis points of the goods subtotal. 825 = 8.25%. */
  bps: number;
}

export interface Menu {
  name: string;
  items: MenuItem[];
  /** The counter's key, so a customer can seal its basket to it (kitchen.ts). */
  counterKey?: string;
  /** What kind of place this is, from a fixed vocabulary (labels.ts). */
  labels?: Label[];
  /**
   * Bulletin key of the venue's photo. A key, not a URL: a URL would have
   * every customer browsing the list fetch from the vendor's own server,
   * which would tell that server who is shopping and when.
   */
  photo?: string;
  /** Named charges on top of the goods. Empty or absent means no extras. */
  tax?: TaxLine[];
}

const PREFIX = "bulletin:";

/** Nobody sensible charges more than this; a typo might. */
export const MAX_TAX_BPS = 5_000;
export const MAX_TAX_LINES = 4;

/**
 * Tax lines as they can safely be shown. A menu is a public document anyone
 * can write, so what comes back is checked before a customer is asked to pay
 * it: a line with no name, a negative rate, a rate over 50%, or a fifth line
 * is dropped rather than displayed. Dropping beats clamping — a bill that
 * quietly shows 50% where the document said 5000% is a worse lie than a bill
 * missing a line.
 */
export function cleanTax(lines: { name: string; bps: number }[]): TaxLine[] {
  return lines
    .filter(
      (t) =>
        typeof t?.name === "string" &&
        t.name.trim().length > 0 &&
        Number.isFinite(t.bps) &&
        Number.isInteger(t.bps) &&
        t.bps > 0 &&
        t.bps <= MAX_TAX_BPS
    )
    .slice(0, MAX_TAX_LINES)
    .map((t) => ({ name: t.name.trim().slice(0, 24), bps: t.bps }));
}

/**
 * The vendor's sections, in the order the vendor put them in. Items with no
 * section fall into one unnamed group at the end, so a menu that never used
 * sections draws exactly as it did before.
 */
export function sectionsOf(menu: Menu): { name: string; items: MenuItem[] }[] {
  const order: string[] = [];
  const groups = new Map<string, MenuItem[]>();
  for (const item of menu.items) {
    const key = item.section?.trim() || "";
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(item);
  }
  // The unnamed group goes last wherever it first appeared: a heading-less run
  // of items reads as "everything else", never as the menu's opening.
  return order
    .sort((a, b) => (a === "" ? 1 : b === "" ? -1 : 0))
    .map((name) => ({ name, items: groups.get(name)! }));
}

export function encodeMenu(menu: Menu): Uint8Array {
  const doc = {
    // v2 adds sections, notes, a photo and tax lines. A v1 reader ignores all
    // four and still shows a working menu, which is why the version goes up
    // rather than the document being replaced.
    v: 2,
    name: menu.name,
    items: menu.items.map((i) => ({
      id: i.id,
      n: i.name,
      p: i.price.toString(),
      ...(i.section?.trim() ? { s: i.section.trim() } : {}),
      ...(i.note?.trim() ? { d: i.note.trim() } : {}),
    })),
    ...(menu.counterKey ? { k: menu.counterKey } : {}),
    ...(menu.labels?.length ? { l: cleanLabels(menu.labels) } : {}),
    ...(menu.photo ? { ph: menu.photo } : {}),
    ...(menu.tax?.length ? { t: cleanTax(menu.tax) } : {}),
  };
  return new TextEncoder().encode(JSON.stringify(doc));
}

export function decodeMenu(bytes: Uint8Array): Menu {
  const doc = JSON.parse(new TextDecoder().decode(bytes)) as {
    v: number;
    name: string;
    items: { id: string; n: string; p: string; s?: string; d?: string }[];
    k?: string;
    l?: string[];
    ph?: string;
    t?: { name: string; bps: number }[];
  };
  if ((doc.v !== 1 && doc.v !== 2) || !Array.isArray(doc.items))
    throw new Error("not a menu");
  return {
    name: String(doc.name ?? ""),
    items: doc.items.map((i) => ({
      id: String(i.id),
      name: String(i.n),
      price: BigInt(i.p),
      ...(i.s ? { section: String(i.s) } : {}),
      ...(i.d ? { note: String(i.d) } : {}),
    })),
    ...(doc.k ? { counterKey: String(doc.k) } : {}),
    // Words this version doesn't know are dropped rather than shown: an
    // unknown label can't be filtered on, so displaying it would mislead.
    ...(doc.l ? { labels: cleanLabels(doc.l) } : {}),
    ...(doc.ph ? { photo: String(doc.ph) } : {}),
    ...(doc.t ? { tax: cleanTax(doc.t) } : {}),
  };
}

/** Store the menu and point the venue at it. Two taps: the upload, then the pointer. */
export async function publishMenu(
  venueId: bigint,
  menu: Menu
): Promise<string> {
  const key = await hostPut(encodeMenu(menu));
  const uri = PREFIX + (key.startsWith("0x") ? key.slice(2) : key);
  await hostCall(
    addressOf("venues"),
    ABI.venues.encodeFunctionData("setMetadata", [venueId, uri])
  );
  return uri;
}

/**
 * Read a venue's menu. Null when it has none, or Bulletin has let it go.
 *
 * Cached by URI, which is safe because the URI is the hash of the content: a
 * changed menu is a different URI. Without this, showing a list of venues meant
 * a Bulletin round trip each, every time the screen opened.
 */
export async function menuOf(metadataURI: string): Promise<Menu | null> {
  if (!metadataURI.startsWith(PREFIX)) return null;
  const kept = await cachedMenu(metadataURI).catch(() => null);
  if (kept) {
    try {
      return decodeMenu(new TextEncoder().encode(kept));
    } catch {
      /* a cached document that no longer parses: fetch it again */
    }
  }
  const bytes = await hostGet(metadataURI.slice(PREFIX.length));
  if (!bytes) return null;
  try {
    const menu = decodeMenu(bytes);
    await cacheMenu(metadataURI, new TextDecoder().decode(bytes)).catch(
      () => undefined
    );
    return menu;
  } catch {
    return null;
  }
}

export const basketTotal = (menu: Menu, picked: Map<string, number>): bigint =>
  menu.items.reduce(
    (total, i) => total + i.price * BigInt(picked.get(i.id) ?? 0),
    0n
  );

/** What the venue sees: the basket as ids and counts, small enough for a statement later. */
export const basketText = (menu: Menu, picked: Map<string, number>): string =>
  menu.items
    .filter((i) => picked.get(i.id))
    .map((i) => `${picked.get(i.id)}× ${i.name}`)
    .join(", ");
