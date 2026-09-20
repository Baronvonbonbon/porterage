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
import { getBytes, keccak256, concat, toBigInt, hexlify, toUtf8Bytes } from "ethers";
import { entropy, LABEL } from "../keys";
import { inHost } from "../host";
import { BN254_R, NATIVE, commitmentOf, type Note, type NotePath } from "./pool";

export interface NoteRecord {
  n: number;
  value: string;
  asset: string;
  /** Set once the deposit (or the withdrawal that made this change note) is in a block. */
  path?: NotePath;
  /** A deposit was sent and its outcome isn't known yet. Recoverable from the pool. */
  pendingSince?: number;
  /** A funding request spending this note is out; the burner it pays, and when. */
  spending?: { burner: number; change: number; since: number; tip: string };
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

interface Book {
  next: number;
  notes: NoteRecord[];
  payouts?: PayoutRecord[];
  nextPayout?: number;
  /** Burners handed out so far; burner n's key is deriveEntropy("porterage:burner:<n>"). */
  burners?: number;
}

const KEY = "porterage.notes.v1";

/** Note n's secrets. Pure given the entropy; exported for tests. */
export function noteSecrets(material: Uint8Array): { nullifier: string; secret: string } {
  const field = (tag: number) => (toBigInt(keccak256(concat([material, new Uint8Array([tag])]))) % BN254_R).toString();
  return { nullifier: field(0), secret: field(1) };
}

export async function noteOf(r: Pick<NoteRecord, "n" | "value" | "asset">): Promise<Note> {
  return { ...noteSecrets(await entropy(LABEL.note(r.n))), value: r.value, asset: r.asset };
}

export async function commitmentFor(r: Pick<NoteRecord, "n" | "value" | "asset">): Promise<bigint> {
  return commitmentOf(await noteOf(r));
}

// ── encrypted persistence ────────────────────────────────────────────────────

let aes: Promise<CryptoKey> | null = null;
const cipherKey = () =>
  (aes ??= entropy(LABEL.notes).then((m) =>
    crypto.subtle.importKey("raw", m as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]),
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
    bytes.slice(12) as BufferSource,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Book;
}

async function save(book: Book): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cipherKey(), toUtf8Bytes(JSON.stringify(book))),
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
export function reserveNotes(values: bigint[], asset = NATIVE): Promise<NoteRecord[]> {
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

export function markSpending(n: number, spending: NoteRecord["spending"]): Promise<void> {
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
    .filter((r) => !r.spent && !r.spending && r.path && BigInt(r.asset) === asset)
    .sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1));
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

export function updatePayout(n: number, patch: Partial<PayoutRecord>): Promise<void> {
  return update((book) => {
    for (const r of book.payouts ?? []) if (r.n === n) Object.assign(r, patch);
  });
}

export async function shieldedBalance(asset = NATIVE): Promise<bigint> {
  return (await spendable(asset)).reduce((a, r) => a + BigInt(r.value), 0n);
}
