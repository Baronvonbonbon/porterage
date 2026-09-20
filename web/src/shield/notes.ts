// The phone's shielded notes (docs/PLAN.md §5.2).
//
// A note's secrets are DERIVED, not stored: note n's nullifier and secret come
// from deriveEntropy("porterage:note:<n>"), which the host returns identically
// on every run. So losing this device's storage loses no money: the notes can
// be found again by recomputing commitments and looking for them in the pool.
//
// What IS stored is bookkeeping: which note numbers are in use, their values,
// their tree positions and whether they're spent. That still says which pool
// leaves are yours, so it's encrypted (AES-GCM, key from deriveEntropy) and
// kept in the host's local storage, or localStorage outside the app.

import { getHostLocalStorage } from "@parity/product-sdk-host";
import {
  getBytes,
  keccak256,
  concat,
  toBigInt,
  hexlify,
  toUtf8Bytes,
} from "ethers";
import { entropy, LABEL } from "../keys";
import { inHost } from "../host";
import {
  BN254_R,
  NATIVE,
  commitmentOf,
  type Note,
  type NotePath,
} from "./pool";

export interface NoteRecord {
  n: number;
  value: string;
  asset: string;
  /** Set once the deposit (or the withdrawal that made this change note) is in a block. */
  path?: NotePath;
  /** A deposit was sent and its outcome isn't known yet. Recoverable from the pool. */
  pendingSince?: number;
  /** A funding request spending this note is out; the burner it pays, and when. */
  spending?: {
    burner: number;
    change: number;
    since: number;
    tip: string;
    tipped?: boolean;
  };
  spent?: boolean;
}

/** A bucket of vault balance turned into a note in the vault's tree (payout.ts). */
export interface PayoutRecord {
  n: number;
  bucket: string;
  /** The block the insert landed in; the leaf search starts here. */
  insertedAt?: number;
  /** The pool note this payout was spent into, once a submitter has done it. */
  spentInto?: number;
}

/** An order this device placed, and the secrets only it holds (order/flow.ts). */
export interface OrderRecord {
  id: string;
  /** Which burner placed it: its key is deriveEntropy("porterage:burner:<n>"). */
  burner: number;
  /** The drop position and the salt its commitment was made with. */
  lat: number;
  lon: number;
  salt: string;
  placedAt: number;
  /** The driver's signing key, recovered at the door: it opens the sealed photo. */
  driverKey?: string;
}

/** One side of a message thread: what this device has said on it (order/chat.ts). */
export interface ThreadRecord {
  /** The thread's topic, which only the two parties can derive. */
  id: string;
  mine: { at: number; text: string }[];
  /** The Bulletin key of the last full transcript put there, if any. */
  archive?: string;
  /** How many of `mine` that transcript covered. */
  archivedUpTo?: number;
}

interface Book {
  next: number;
  notes: NoteRecord[];
  payouts?: PayoutRecord[];
  nextPayout?: number;
  orders?: OrderRecord[];
  /** Burners handed out so far; burner n's key is deriveEntropy("porterage:burner:<n>"). */
  burners?: number;
  threads?: ThreadRecord[];
  /** Where this device says it is, and how far it cares to look. Never sent. */
  here?: { lat: number; lon: number; metres: number };
  /** Drops this device has been given as the driver, by order id. */
  drops?: Record<string, { lat: number; lon: number }>;
  /** Menus already fetched, by the Bulletin URI they came from. */
  menus?: { uri: string; doc: string; used: number }[];
}

const KEY = "porterage.notes.v1";

/** Note n's secrets. Pure given the entropy; exported for tests. */
export function noteSecrets(material: Uint8Array): {
  nullifier: string;
  secret: string;
} {
  const field = (tag: number) =>
    (
      toBigInt(keccak256(concat([material, new Uint8Array([tag])]))) % BN254_R
    ).toString();
  return { nullifier: field(0), secret: field(1) };
}

export async function noteOf(
  r: Pick<NoteRecord, "n" | "value" | "asset">
): Promise<Note> {
  return {
    ...noteSecrets(await entropy(LABEL.note(r.n))),
    value: r.value,
    asset: r.asset,
  };
}

export async function commitmentFor(
  r: Pick<NoteRecord, "n" | "value" | "asset">
): Promise<bigint> {
  return commitmentOf(await noteOf(r));
}

// ── encrypted persistence ────────────────────────────────────────────────────

let aes: Promise<CryptoKey> | null = null;
const cipherKey = () =>
  (aes ??= entropy(LABEL.notes).then((m) =>
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
  return localStorage.getItem(KEY) ?? "";
}

async function writeRaw(v: string): Promise<void> {
  if (await inHost()) {
    const store = await getHostLocalStorage();
    if (store) return store.writeString(KEY, v);
  }
  localStorage.setItem(KEY, v);
}

async function load(): Promise<Book> {
  const raw = await readRaw();
  if (!raw) return { next: 0, notes: [] };
  const bytes = getBytes(raw);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) as BufferSource },
    await cipherKey(),
    bytes.slice(12) as BufferSource
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Book;
}

async function save(book: Book): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await cipherKey(),
      toUtf8Bytes(JSON.stringify(book))
    )
  );
  await writeRaw(hexlify(concat([iv, body])));
}

// Every change goes through one queue, so two quick updates can't interleave a
// read and a write and lose one of them.
let queue: Promise<unknown> = Promise.resolve();
function update<T>(fn: (book: Book) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const book = await load();
    const out = await fn(book);
    await save(book);
    return out;
  });
  queue = run.catch(() => undefined);
  return run;
}

// ── the API the rest of the app uses ─────────────────────────────────────────

export function allNotes(): Promise<NoteRecord[]> {
  return queue.then(load).then((b) => b.notes);
}

/** Reserve note numbers for new notes, recorded as pending before anything is sent. */
export function reserveNotes(
  values: bigint[],
  asset = NATIVE
): Promise<NoteRecord[]> {
  return update((book) => {
    const recs = values.map((v) => ({
      n: book.next++,
      value: v.toString(),
      asset: asset.toString(),
      pendingSince: Date.now(),
    }));
    book.notes.push(...recs);
    return recs;
  });
}

export function settleNotes(paths: Map<number, NotePath>): Promise<void> {
  return update((book) => {
    for (const r of book.notes) {
      const p = paths.get(r.n);
      if (p) {
        r.path = p;
        delete r.pendingSince;
      }
    }
  });
}

/** A deposit that certainly didn't happen (the user declined, or it failed before sending). */
export function dropNotes(ns: number[]): Promise<void> {
  return update((book) => {
    book.notes = book.notes.filter((r) => !ns.includes(r.n) || !r.pendingSince);
  });
}

export function nextBurner(): Promise<number> {
  return update((book) => {
    const n = book.burners ?? 0;
    book.burners = n + 1;
    return n;
  });
}

export function markSpending(
  n: number,
  spending: NoteRecord["spending"]
): Promise<void> {
  return update((book) => {
    for (const r of book.notes) if (r.n === n) r.spending = spending;
  });
}

export function markSpent(n: number): Promise<void> {
  return update((book) => {
    for (const r of book.notes) if (r.n === n) r.spent = true;
  });
}

/** Unspent, settled notes of one asset, smallest first. */
export async function spendable(asset = NATIVE): Promise<NoteRecord[]> {
  return (await allNotes())
    .filter(
      (r) => !r.spent && !r.spending && r.path && BigInt(r.asset) === asset
    )
    .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1));
}

export function allOrders(): Promise<OrderRecord[]> {
  return queue.then(load).then((b) => b.orders ?? []);
}

export function rememberOrder(rec: OrderRecord): Promise<void> {
  return update((book) => {
    book.orders = [...(book.orders ?? []).filter((o) => o.id !== rec.id), rec];
  });
}

export function allPayouts(): Promise<PayoutRecord[]> {
  return queue.then(load).then((b) => b.payouts ?? []);
}

/** Reserve a payout note number, recorded before the insert is signed. */
export function reservePayout(bucket: bigint): Promise<PayoutRecord> {
  return update((book) => {
    const rec = { n: book.nextPayout ?? 0, bucket: bucket.toString() };
    book.nextPayout = rec.n + 1;
    book.payouts = [...(book.payouts ?? []), rec];
    return rec;
  });
}

export function updatePayout(
  n: number,
  patch: Partial<PayoutRecord>
): Promise<void> {
  return update((book) => {
    for (const r of book.payouts ?? []) if (r.n === n) Object.assign(r, patch);
  });
}

export function threadOf(id: string): Promise<{ at: number; text: string }[]> {
  return queue
    .then(load)
    .then((b) => b.threads?.find((t) => t.id === id)?.mine ?? []);
}

export function threadRecord(id: string): Promise<ThreadRecord | null> {
  return queue
    .then(load)
    .then((b) => b.threads?.find((t) => t.id === id) ?? null);
}

/** Note that the whole transcript so far is on Bulletin under this key. */
export function rememberArchive(
  id: string,
  archive: string,
  archivedUpTo: number
): Promise<void> {
  return update((book) => {
    for (const t of book.threads ?? []) {
      if (t.id === id) {
        t.archive = archive;
        t.archivedUpTo = archivedUpTo;
      }
    }
  });
}

/**
 * Record something this device said, and return the whole side back.
 * Kept locally because a sealed envelope can't be opened by the one who sealed
 * it, so a device can't read its own statements off the topic.
 */
export function rememberSaid(
  id: string,
  text: string,
  at = Date.now()
): Promise<{ at: number; text: string }[]> {
  return update((book) => {
    book.threads ??= [];
    const t = book.threads.find((x) => x.id === id) ?? { id, mine: [] };
    if (!book.threads.includes(t)) book.threads.push(t);
    t.mine.push({ at, text });
    // Only the recent tail is ever republished; keeping more would grow storage
    // for messages that can no longer reach the other side.
    if (t.mine.length > 32) t.mine = t.mine.slice(-32);
    return t.mine;
  });
}

/**
 * The pin this device filters by, and the radius. It is kept in the encrypted
 * book and never published: a driver's own position is nobody's business, and
 * the filtering it drives all happens here.
 */
export function savedHere(): Promise<{
  lat: number;
  lon: number;
  metres: number;
} | null> {
  return queue.then(load).then((b) => b.here ?? null);
}

export function saveHere(
  here: { lat: number; lon: number; metres: number } | null
): Promise<void> {
  return update((book) => {
    if (here) book.here = here;
    else delete book.here;
  });
}

/**
 * Keep a drop a driver was given. The statement it arrived in expires, and an
 * address that vanished halfway through a delivery would be worse than one that
 * never came.
 */
export function rememberDrop(
  orderId: bigint,
  at: { lat: number; lon: number }
): Promise<void> {
  return update((book) => {
    book.drops = { ...(book.drops ?? {}), [orderId.toString()]: at };
  });
}

export function knownDrops(): Promise<
  Record<string, { lat: number; lon: number }>
> {
  return queue.then(load).then((b) => b.drops ?? {});
}

/**
 * Menus already fetched, kept by the URI they came from.
 *
 * A Bulletin URI is the hash of its content, so a cached menu can never be
 * stale — a changed menu is a different URI, and the venue's on-chain pointer
 * changes with it. That is what makes this safe to keep indefinitely.
 *
 * It lives in the encrypted book even though a menu is public: WHICH menus a
 * device has fetched says something about where its owner shops, and the book
 * is already encrypted, so the discretion is free.
 */
const MENU_CACHE = 60;

export function cachedMenu(uri: string): Promise<string | null> {
  return update((book) => {
    const hit = book.menus?.find((m) => m.uri === uri);
    if (hit) hit.used = Date.now();
    return hit?.doc ?? null;
  });
}

export function cacheMenu(uri: string, doc: string): Promise<void> {
  return update((book) => {
    const menus = (book.menus ?? []).filter((m) => m.uri !== uri);
    menus.push({ uri, doc, used: Date.now() });
    // Oldest use first out, so a phone that has browsed a city doesn't grow
    // without bound.
    book.menus = menus.sort((a, b) => b.used - a.used).slice(0, MENU_CACHE);
  });
}

export async function shieldedBalance(asset = NATIVE): Promise<bigint> {
  return (await spendable(asset)).reduce((a, r) => a + BigInt(r.value), 0n);
}
