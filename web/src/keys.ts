// Keys the app holds (docs/PLAN.md §3.1).
//
// Every key is derived from the host's deriveEntropy, which returns the same 32
// bytes for the same input on every run and every new build of this product.
// So the app keeps no key material at all: a session key or an order's burner
// is recomputed from its label whenever it's needed.
//
// Outside the Polkadot app there is no host entropy. In a plain browser (for
// development) the app uses a random seed kept in localStorage instead, and
// says so: those keys are only as safe as that browser.

import { deriveEntropy } from "@parity/product-sdk-host";
import { Wallet, getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";
import { inHost, withTimeout } from "./host";

export type KeySource = "host" | "browser";

const ENTROPY_MS = 10_000;
const DEV_SEED = "porterage.devSeed";

/** Labels are namespaced so a key for one purpose can never equal a key for another. */
export const LABEL = {
  session: (epoch: number) => `porterage:session:${epoch}`,
  burner: (n: number) => `porterage:burner:${n}`,
  notes: "porterage:notes",
  note: (n: number) => `porterage:note:${n}`,
  payout: (n: number) => `porterage:payout:${n}`,
  ops: (epoch: number) => `porterage:ops:${epoch}`,
  /** The books (books/ledger.ts): its own key, never the note book's. */
  books: "porterage:books",
  /** What the daily backup of the books is encrypted under. */
  booksBackup: "porterage:books:backup",
} as const;

let source: Promise<KeySource> | null = null;

/** Where keys come from in this runtime. */
export function keySource(): Promise<KeySource> {
  return (source ??= inHost().then((h) => (h ? "host" : "browser")));
}

function devSeed(): Uint8Array {
  let seed = localStorage.getItem(DEV_SEED);
  if (!seed) {
    seed = hexlify(crypto.getRandomValues(new Uint8Array(32)));
    localStorage.setItem(DEV_SEED, seed);
  }
  return getBytes(seed);
}

/** 32 bytes of key material for `label`, the same every time. */
export async function entropy(label: string): Promise<Uint8Array> {
  if ((await keySource()) === "host") {
    const r = await withTimeout(
      deriveEntropy(toUtf8Bytes(label)),
      ENTROPY_MS,
      "key derivation"
    );
    if (!r.ok) throw new Error(`key derivation failed: ${String(r.error)}`);
    return r.value;
  }
  const seed = devSeed();
  const msg = toUtf8Bytes(label);
  const joined = new Uint8Array(seed.length + msg.length);
  joined.set(seed);
  joined.set(msg, seed.length);
  return getBytes(keccak256(joined));
}

/** A secp256k1 key from entropy. Out-of-range values (vanishingly rare) are rehashed. */
export function walletFrom(material: Uint8Array): Wallet {
  let k = material;
  for (;;) {
    try {
      return new Wallet(hexlify(k));
    } catch {
      k = getBytes(keccak256(k));
    }
  }
}

/** The session key for `epoch` (docs/PLAN.md §3.2). Bump the epoch to rotate. */
export async function sessionKey(epoch = 0): Promise<Wallet> {
  return walletFrom(await entropy(LABEL.session(epoch)));
}

/** Order `n`'s burner: a fresh on-chain identity per order (docs/PLAN.md §3.1). */
export async function burner(n: number): Promise<Wallet> {
  return walletFrom(await entropy(LABEL.burner(n)));
}

/**
 * The operations key (docs/PLAN.md §6): the key an arbiter reads cases with and
 * signs rulings with. It has to be secp256k1 — a case is sealed by ECDH on that
 * curve — which is why an arbiter can't simply be a host account, and why this
 * is derived rather than being the host's own key.
 */
export async function opsKey(epoch = 0): Promise<Wallet> {
  return walletFrom(await entropy(LABEL.ops(epoch)));
}

/** For tests. */
export function _resetKeysForTests(): void {
  source = null;
}
