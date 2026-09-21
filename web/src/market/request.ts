// A funding request (docs/PLAN.md §5.3): a withdrawal proof that anyone may
// submit, packed to fit one Statement Store statement.
//
// It carries only what a submitter can't work out for itself. Of the proof's
// eight public signals, four are derived: the withdrawn value and recipient
// travel in the header, the tree depth is always 128, `context` is the
// recipient's hash, and the asset is PAS (version 1 funds in PAS only).
//
// VERSION 2 carries an auction schedule rather than a flat fee. A single number
// was either too high (the requester overpaid every time) or too low (nobody
// submitted and the rail quietly stopped working); see market/auction.ts for
// why the price rises rather than being bid down.
//
//   0      version (2)
//   1      flags (0)
//   2..22  recipient: the fresh burner the proof pays
//   22..34 withdrawn value, wei, u96 big-endian
//   34..42 floor fee, gwei, u64 big-endian
//   42..50 ceiling fee, gwei, u64 big-endian
//   50..56 startedAt, unix seconds, u48
//   56..58 climbSecs, u16
//   58..186   public signals 0, 1, 2 and 6 (change commitment, and three the
//             circuit fixes: nullifier hash and roots; passed through as they are)
//   186..442  the proof: pA, pB (as the pool takes it), pC
//
// 442 bytes, under the 512 a statement's data may hold.

import { getAddress, getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";
import { contextFor } from "../shield/pool";
import type { WithdrawalProof } from "../shield/withdraw";
import { priceAt, type Schedule } from "./auction";

export const REQUEST_BYTES = 442;
const VERSION = 2;
const GWEI = 10n ** 9n;

/** The public topics every submitter listens on. */
export const FUND_TOPIC = keccak256(toUtf8Bytes("porterage:fund:v1"));
export const PAYOUT_TOPIC = keccak256(toUtf8Bytes("porterage:payout:v1"));
/** One channel per kind, so a new request replaces this account's previous one. */
export const FUND_CHANNEL = keccak256(toUtf8Bytes("porterage:fund:channel"));
export const PAYOUT_CHANNEL = keccak256(
  toUtf8Bytes("porterage:payout:channel")
);

export interface FundRequest {
  proof: WithdrawalProof;
  withdrawn: bigint;
  /** What the burner will pay, as a price that rises with the clock. */
  schedule: Schedule;
}

/** What this request is offering right now. Wei, never above the ceiling. */
export const feeNow = (r: FundRequest, at?: number): bigint =>
  priceAt(r.schedule, at);

function put(out: Uint8Array, at: number, v: bigint, bytes: number) {
  for (let i = bytes - 1; i >= 0; i--) {
    out[at + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("value too large for its field");
}
function get(b: Uint8Array, at: number, bytes: number): bigint {
  let v = 0n;
  for (let i = 0; i < bytes; i++) v = (v << 8n) | BigInt(b[at + i]);
  return v;
}

const proofWords = (p: WithdrawalProof) => [
  p.pA[0],
  p.pA[1],
  p.pB[0][0],
  p.pB[0][1],
  p.pB[1][0],
  p.pB[1][1],
  p.pC[0],
  p.pC[1],
];

export function encodeRequest(r: FundRequest): Uint8Array {
  const { proof } = r;
  const s = proof.pubSignals;
  if (
    BigInt(s[3]) !== r.withdrawn ||
    s[4] !== "128" ||
    BigInt(s[5]) !== contextFor(proof.recipient) ||
    s[7] !== "0"
  ) {
    throw new Error("the proof's public signals don't match the request");
  }
  const { floor, ceiling, startedAt, climbSecs } = r.schedule;
  if (ceiling < floor) throw new Error("a ceiling below the floor");
  const out = new Uint8Array(REQUEST_BYTES);
  out[0] = VERSION;
  out[1] = 0;
  out.set(getBytes(getAddress(proof.recipient)), 2);
  put(out, 22, r.withdrawn, 12);
  put(out, 34, floor / GWEI, 8);
  put(out, 42, ceiling / GWEI, 8);
  put(out, 50, BigInt(startedAt), 6);
  put(out, 56, BigInt(climbSecs), 2);
  [s[0], s[1], s[2], s[6]].forEach((v, i) =>
    put(out, 58 + 32 * i, BigInt(v), 32)
  );
  proofWords(proof).forEach((v, i) => put(out, 186 + 32 * i, BigInt(v), 32));
  return out;
}

export function decodeRequest(b: Uint8Array): FundRequest {
  if (b.length !== REQUEST_BYTES || b[0] !== VERSION)
    throw new Error("not a version 2 funding request");
  const recipient = getAddress(hexlify(b.slice(2, 22)));
  const withdrawn = get(b, 22, 12);
  const floor = get(b, 34, 8) * GWEI;
  const ceiling = get(b, 42, 8) * GWEI;
  // A ceiling under the floor would make `priceAt` fall with the clock. It can
  // only come from a malformed or hostile request, and a submitter reading one
  // should see a flat offer, not a descending one.
  if (ceiling < floor) throw new Error("a ceiling below the floor");
  const schedule = {
    floor,
    ceiling,
    startedAt: Number(get(b, 50, 6)),
    climbSecs: Number(get(b, 56, 2)),
  };
  const pub = [0, 1, 2, 3].map((i) => get(b, 58 + 32 * i, 32).toString());
  const w = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
    get(b, 186 + 32 * i, 32).toString()
  );
  return {
    withdrawn,
    schedule,
    proof: {
      recipient,
      pA: [w[0], w[1]],
      pB: [
        [w[2], w[3]],
        [w[4], w[5]],
      ],
      pC: [w[6], w[7]],
      pubSignals: [
        pub[0],
        pub[1],
        pub[2],
        withdrawn.toString(),
        "128",
        contextFor(recipient).toString(),
        pub[3],
        "0",
      ],
    },
  };
}

// ── payout spends ────────────────────────────────────────────────────────────
//
// The other half of the market (docs/PLAN.md §5.6): a payee proves ownership of
// a note in the vault's tree and binds the pool commitment the deposit must
// fund. Submitting it must NOT be the payee, or their account is tied to the new
// pool note. There's no tip: the payee has nothing spendable to tip with yet,
// and the gas is small. Submitters do these because they need them too.
//
//   0      version (1)
//   1      kind (2)
//   2..14  bucket, wei, u96
//   14..46 root the proof was built against
//   46..78 nullifier hash
//   78..110 the Kusama Shield commitment the deposit funds
//   110..366 the proof's eight words
export const PAYOUT_BYTES = 366;
const PAYOUT_KIND = 2;

export interface PayoutRequest {
  bucket: bigint;
  root: string;
  nullifierHash: string;
  ksCommitment: string;
  /** The proof's words, in the order PorterShieldVerifier takes them. */
  words: string[];
}

export function encodePayout(r: PayoutRequest): Uint8Array {
  if (r.words.length !== 8) throw new Error("a proof is eight words");
  const out = new Uint8Array(PAYOUT_BYTES);
  out[0] = VERSION;
  out[1] = PAYOUT_KIND;
  put(out, 2, r.bucket, 12);
  [r.root, r.nullifierHash, r.ksCommitment].forEach((v, i) =>
    put(out, 14 + 32 * i, BigInt(v), 32)
  );
  r.words.forEach((v, i) => put(out, 110 + 32 * i, BigInt(v), 32));
  return out;
}

export function decodePayout(b: Uint8Array): PayoutRequest {
  if (b.length !== PAYOUT_BYTES || b[0] !== VERSION || b[1] !== PAYOUT_KIND) {
    throw new Error("not a version 1 payout request");
  }
  return {
    bucket: get(b, 2, 12),
    root: get(b, 14, 32).toString(),
    nullifierHash: get(b, 46, 32).toString(),
    ksCommitment: "0x" + get(b, 78, 32).toString(16).padStart(64, "0"),
    words: [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      get(b, 110 + 32 * i, 32).toString()
    ),
  };
}
