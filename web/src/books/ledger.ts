// The books: what was sold, what was earned, what was bought.
//
// WHY THIS HAS TO EXIST, stated plainly because the gap was invisible.
//
// A venue's orders arrived as sealed statements, were held in React state, and
// were gone on refresh — and the statements themselves expire in about an hour,
// so there was nothing to go back to. The chain kept the money and not the
// items, by design: it records how much, never what. So a venue could not
// reconcile a day, count what it had sold, or produce a receipt.
//
// The sharp end of that is tax. `orderValue` is goods PLUS the vendor's named
// tax lines (order/bag.ts), so the venue is PAID the tax it is expected to
// remit — and nothing recorded how much of it was tax. Worse, the split is
// computed on the customer's device from the menu as it stood at that moment,
// so once the venue edits a price it cannot be worked out again. A number that
// is owed to a tax authority, paid to the venue, and unrecoverable a day later
// is not a missing feature; it is a hole.
//
// So a sale is written down as it was charged, at the moment it was charged.
//
// WHAT THIS IS NOT. It is not an accounting system. Real venues already have
// one, and the useful thing to be is a clean source of rows for it — which is
// what `csv.ts` is for. The lesson from how restaurants actually use DoorDash
// is that the portal is not their books; their POS is, and the integration is
// the product.
//
// WHAT IT DELIBERATELY DOES NOT KEEP. No customer key, no burner address, no
// position. A sale row says what left the kitchen and what it cost, not who ate
// it. The order id is kept because the chain already publishes it against that
// order's account, so writing it down here reveals nothing new and it is the
// only way to reconcile a row against a payout.

import { concat, getBytes, hexlify, toUtf8Bytes } from "ethers";
import { getHostLocalStorage } from "@parity/product-sdk-host";
import { inHost } from "../host";
import { entropy, LABEL } from "../keys";
import type { Bill } from "../order/bag";

const KEY = "porterage.books.v1";
const VERSION = 1;

/** One line of a bill, frozen. Names and prices are copied, never referenced. */
export interface LedgerLine {
  /** The menu item id, for matching against inventory. */
  id: string;
  /** What it was called when it was sold. The menu may say something else now. */
  name: string;
  count: number;
  /** Unit price at the time, wei as a decimal string. */
  unitWei: string;
  /** count x unit. */
  wei: string;
}

/** A named charge, frozen with the rate that produced it. */
export interface LedgerTax {
  name: string;
  bps: number;
  wei: string;
}

export type EntryKind = "sale" | "earning" | "purchase";

export interface LedgerEntry {
  kind: EntryKind;
  /** The on-chain order this belongs to. */
  orderId: string;
  /** When this device wrote the row, ms. Not when the order was created. */
  at: number;
  /** Which venue, for a device that runs more than one. */
  venueId?: string;
  /** What the venue is called, frozen. */
  venue?: string;

  // ── a sale or a purchase ──
  lines?: LedgerLine[];
  goods?: string;
  tax?: LedgerTax[];
  taxTotal?: string;
  /** goods + tax. The escrowed `orderValue`. */
  total?: string;
  /**
   * What the chain says was escrowed for goods, when it could be read. If this
   * differs from `total`, the customer's menu and the venue's disagreed, and
   * an accountant should see both rather than a number that has been quietly
   * reconciled for them.
   */
  chainValue?: string;

  // ── a driver's earning ──
  fare?: string;
  tip?: string;
  /** The protocol's cut, already deducted from what landed. */
  fee?: string;
  /** fare - fee + tip. */
  net?: string;

  /** The symbol shown beside the amounts on this device at the time. */
  symbol?: string;
}

interface Books {
  v: number;
  entries: LedgerEntry[];
  /** Days already backed up, as YYYY-MM-DD, so a close is not repeated. */
  closed?: string[];
}

// ── encrypted persistence, the same shape as the note book ──────────────────
//
// Its own key and its own storage slot. The note book holds the secrets that
// spend money; these are records about money. Mixing them would mean a bug in
// one could corrupt the other, and would make "export my books" awkwardly close
// to "export my keys".

let aes: Promise<CryptoKey> | null = null;
const cipherKey = () =>
  (aes ??= entropy(LABEL.books).then((m) =>
    crypto.subtle.importKey("raw", m as BufferSource, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ])
  ));

async function readRaw(): Promise<string> {
  if (await inHost()) {
    const store = await getHostLocalStorage();
    if (store) return store.readString(KEY);
  }
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

async function writeRaw(v: string): Promise<void> {
  if (await inHost()) {
    const store = await getHostLocalStorage();
    if (store) return store.writeString(KEY, v);
  }
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* a device that cannot remember is not a reason to fail the order */
  }
}

async function load(): Promise<Books> {
  const raw = await readRaw();
  if (!raw) return { v: VERSION, entries: [] };
  try {
    const bytes = getBytes(raw);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12) as BufferSource },
      await cipherKey(),
      bytes.slice(12) as BufferSource
    );
    return JSON.parse(new TextDecoder().decode(plain)) as Books;
  } catch {
    // Unreadable books must not take the app down with them: a venue whose
    // storage was corrupted still has to be able to take orders today.
    return { v: VERSION, entries: [] };
  }
}

async function save(books: Books): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await cipherKey(),
      toUtf8Bytes(JSON.stringify(books))
    )
  );
  await writeRaw(hexlify(concat([iv, body])));
}

let queue: Promise<unknown> = Promise.resolve();
function update<T>(fn: (b: Books) => T): Promise<T> {
  const run = queue.then(async () => {
    const books = await load();
    const out = fn(books);
    await save(books);
    return out;
  });
  queue = run.catch(() => undefined);
  return run;
}

// ── writing ─────────────────────────────────────────────────────────────────

/** Freeze a bill into ledger lines. Everything is copied, nothing referenced. */
export function linesOf(bill: Bill): {
  lines: LedgerLine[];
  goods: string;
  tax: LedgerTax[];
  taxTotal: string;
  total: string;
} {
  return {
    lines: bill.items.map((i) => ({
      id: i.item.id,
      name: i.item.name,
      count: i.count,
      unitWei: i.item.price.toString(),
      wei: i.wei.toString(),
    })),
    goods: bill.goods.toString(),
    tax: bill.tax.map((t) => ({
      name: t.name,
      bps: t.bps ?? 0,
      wei: t.wei.toString(),
    })),
    taxTotal: bill.taxTotal.toString(),
    total: bill.total.toString(),
  };
}

/**
 * Write a row, or replace the one already there for that order and kind.
 *
 * Replacing rather than appending matters: a venue's basket subscription
 * replays statements it has already seen, so the same sale arrives more than
 * once. Appending would inflate a day's takings, which is the one kind of bug
 * an accounting feature must never have.
 */
export function record(entry: LedgerEntry): Promise<void> {
  return update((b) => {
    b.entries = mergeEntry(b.entries, entry);
  });
}

/**
 * The dedup rule, pulled out so it can be tested without a browser. One row per
 * (order, kind): a later write about the same order REPLACES the earlier one
 * rather than sitting beside it.
 *
 * This is the single most important line in the file. A venue's basket
 * subscription replays statements it has already seen, and a driver's job list
 * re-reads the same delivered order on every poll. Appending would count both,
 * and a day's takings would climb on its own while nobody was looking. An
 * accounting feature may be incomplete; it may not be wrong.
 */
export function mergeEntry(
  entries: LedgerEntry[],
  entry: LedgerEntry
): LedgerEntry[] {
  const kept = entries.filter(
    (e) => !(e.orderId === entry.orderId && e.kind === entry.kind)
  );
  // Keep the ORIGINAL timestamp when replacing: the row belongs to the day the
  // sale happened, not the day a replay was seen. Without this a venue that
  // reopens the app after midnight moves yesterday's takings into today.
  const had = entries.find(
    (e) => e.orderId === entry.orderId && e.kind === entry.kind
  );
  const row = had ? { ...entry, at: had.at } : entry;
  return [...kept, row].sort((x, y) => x.at - y.at);
}

export function allEntries(): Promise<LedgerEntry[]> {
  return queue.then(load).then((b) => b.entries);
}

export async function entriesOfKind(kind: EntryKind): Promise<LedgerEntry[]> {
  return (await allEntries()).filter((e) => e.kind === kind);
}

/** Forget everything of one kind. The customer's receipts are theirs to drop. */
export function forgetKind(kind: EntryKind): Promise<void> {
  return update((b) => {
    b.entries = b.entries.filter((e) => e.kind !== kind);
  });
}

// ── days ────────────────────────────────────────────────────────────────────

/** Local calendar day, which is the day a venue means when it says "today". */
export const dayOf = (at: number): string => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export async function entriesOfDay(
  kind: EntryKind,
  day: string
): Promise<LedgerEntry[]> {
  return (await entriesOfKind(kind)).filter((e) => dayOf(e.at) === day);
}

export async function days(kind: EntryKind): Promise<string[]> {
  const seen = new Set((await entriesOfKind(kind)).map((e) => dayOf(e.at)));
  return [...seen].sort().reverse();
}

export async function closedDays(): Promise<string[]> {
  return (await load()).closed ?? [];
}

export function markClosed(day: string): Promise<void> {
  return update((b) => {
    b.closed = [...new Set([...(b.closed ?? []), day])];
  });
}

/** What a day came to, for the summary line above an export. */
export function totalsOf(entries: LedgerEntry[]): {
  orders: number;
  goods: bigint;
  tax: bigint;
  total: bigint;
  net: bigint;
} {
  let goods = 0n;
  let tax = 0n;
  let total = 0n;
  let net = 0n;
  for (const e of entries) {
    goods += BigInt(e.goods ?? "0");
    tax += BigInt(e.taxTotal ?? "0");
    total += BigInt(e.total ?? "0");
    net += BigInt(e.net ?? "0");
  }
  return { orders: entries.length, goods, tax, total, net };
}
