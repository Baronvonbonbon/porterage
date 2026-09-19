// A funding request (docs/PLAN.md §5.3): a withdrawal proof that anyone may
// submit, packed to fit one Statement Store statement.
//
// It carries only what a submitter can't work out for itself. Of the proof's
// eight public signals, four are derived: the withdrawn value and recipient
// travel in the header, the tree depth is always 128, `context` is the
// recipient's hash, and the asset is PAS (version 1 funds in PAS only).
//
//   0      version (1)
//   1      flags (0)
//   2..22  recipient: the fresh burner the proof pays
//   22..34 withdrawn value, wei, u96 big-endian
//   34..42 fee the burner tips the submitter, gwei, u64 big-endian
//   42..170   public signals 0, 1, 2 and 6 (change commitment, and three the
//             circuit fixes: nullifier hash and roots; passed through as they are)
//   170..426  the proof: pA, pB (as the pool takes it), pC
//
// 426 bytes, under the 512 a statement's data may hold.

import { getAddress, getBytes, hexlify, keccak256, toUtf8Bytes } from "ethers";
import { contextFor } from "../shield/pool";
import type { WithdrawalProof } from "../shield/withdraw";

export const REQUEST_BYTES = 426;
const VERSION = 1;
const GWEI = 10n ** 9n;

/** The public topic every submitter listens on. */
export const FUND_TOPIC = keccak256(toUtf8Bytes("porterage:fund:v1"));
/** One channel per requester, so a new request replaces that account's previous one. */
export const FUND_CHANNEL = keccak256(toUtf8Bytes("porterage:fund:channel"));

export interface FundRequest {
  proof: WithdrawalProof;
  withdrawn: bigint;
  /** What the burner pays the submitter once funded, in wei (rounded down to gwei). */
  fee: bigint;
}

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

const proofWords = (p: WithdrawalProof) => [p.pA[0], p.pA[1], p.pB[0][0], p.pB[0][1], p.pB[1][0], p.pB[1][1], p.pC[0], p.pC[1]];

export function encodeRequest(r: FundRequest): Uint8Array {
  const { proof } = r;
  const s = proof.pubSignals;
  if (BigInt(s[3]) !== r.withdrawn || s[4] !== "128" || BigInt(s[5]) !== contextFor(proof.recipient) || s[7] !== "0") {
    throw new Error("the proof's public signals don't match the request");
  }
  const out = new Uint8Array(REQUEST_BYTES);
  out[0] = VERSION;
  out[1] = 0;
  out.set(getBytes(getAddress(proof.recipient)), 2);
  put(out, 22, r.withdrawn, 12);
  put(out, 34, r.fee / GWEI, 8);
  [s[0], s[1], s[2], s[6]].forEach((v, i) => put(out, 42 + 32 * i, BigInt(v), 32));
  proofWords(proof).forEach((v, i) => put(out, 170 + 32 * i, BigInt(v), 32));
  return out;
}

export function decodeRequest(b: Uint8Array): FundRequest {
  if (b.length !== REQUEST_BYTES || b[0] !== VERSION) throw new Error("not a version 1 funding request");
  const recipient = getAddress(hexlify(b.slice(2, 22)));
  const withdrawn = get(b, 22, 12);
  const fee = get(b, 34, 8) * GWEI;
  const pub = [0, 1, 2, 3].map((i) => get(b, 42 + 32 * i, 32).toString());
  const w = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => get(b, 170 + 32 * i, 32).toString());
  return {
    withdrawn,
    fee,
    proof: {
      recipient,
      pA: [w[0], w[1]],
      pB: [
        [w[2], w[3]],
        [w[4], w[5]],
      ],
      pC: [w[6], w[7]],
      pubSignals: [pub[0], pub[1], pub[2], withdrawn.toString(), "128", contextFor(recipient).toString(), pub[3], "0"],
    },
  };
}
