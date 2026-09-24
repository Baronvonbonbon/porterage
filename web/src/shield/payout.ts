// Getting paid privately (docs/PLAN.md §5.6), ported from FARE's shieldnote.ts.
//
// Two steps, deliberately far apart in time:
//
//   1. INSERT. A fixed bucket of the payee's vault balance becomes a note in the
//      vault's own tree. This is signed by the payee's account and is linked to
//      them, like any pool deposit.
//   2. SPEND. A Groth16 proof shows ownership of SOME unspent note in the tree
//      and binds a Kusama Shield commitment. It reveals only a nullifier, so the
//      anonymity set is every unspent note. The proof fixes where the money
//      goes, so anyone can submit it — and it must be someone else: submitting
//      it yourself would tie your account to the new pool note.
//
// The resulting pool note is derived from this device's entropy like every other
// note, so it spends through exactly the customer's path.

import {
  AbiCoder,
  Contract,
  keccak256,
  toBeHex,
  toBigInt,
  toUtf8Bytes,
  type Provider,
} from "ethers";
// Per-arity entry points: the barrel costs all sixteen arities' constants.
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { entropy, LABEL } from "../keys";
import { BN254_R } from "./pool";
import { noteSecrets } from "./notes";

export const NOTE_DEPTH = 16; // must match PorterVault.NOTE_DEPTH and the circuit

const WASM = "./shield/shieldnote.wasm";
const ZKEY = "./shield/shieldnote.zkey";

export interface PayoutNote {
  /** Payout note number: its secrets are deriveEntropy("porterage:payout:<n>"). */
  n: number;
  nullifier: string;
  secret: string;
  bucket: string;
}

/** leaf = Poseidon(Poseidon(nullifier, secret), bucket): the bucket is bound in. */
export const payoutCommitment = (n: PayoutNote): bigint =>
  poseidon2([
    poseidon2([BigInt(n.nullifier), BigInt(n.secret)]),
    BigInt(n.bucket),
  ]);
export const payoutNullifierHash = (n: PayoutNote): bigint =>
  poseidon1([BigInt(n.nullifier)]);

export async function payoutNote(
  n: number,
  bucket: bigint
): Promise<PayoutNote> {
  return {
    n,
    bucket: bucket.toString(),
    ...noteSecrets(await entropy(LABEL.payout(n))),
  };
}

/** Empty-subtree roots; these must equal PorterVault.noteZeros. */
export function zeroHashes(depth = NOTE_DEPTH): bigint[] {
  const z = [0n];
  for (let i = 1; i <= depth; i++) z.push(poseidon2([z[i - 1], z[i - 1]]));
  return z;
}

/** A sparse mirror of the vault's incremental tree: empty subtrees short-circuit. */
export class NoteTree {
  private memo = new Map<string, bigint>();
  private zeros = zeroHashes();
  constructor(public leaves: bigint[] = []) {}

  private node(level: number, index: number): bigint {
    if (index * 2 ** level >= this.leaves.length) return this.zeros[level];
    if (level === 0) return this.leaves[index];
    const key = `${level}:${index}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const v = poseidon2([
      this.node(level - 1, index * 2),
      this.node(level - 1, index * 2 + 1),
    ]);
    this.memo.set(key, v);
    return v;
  }

  root(): bigint {
    return this.node(NOTE_DEPTH, 0);
  }

  path(index: number): { elements: bigint[]; indices: number[] } {
    const elements: bigint[] = [];
    const indices: number[] = [];
    let idx = index;
    for (let lv = 0; lv < NOTE_DEPTH; lv++) {
      elements.push(this.node(lv, idx % 2 === 0 ? idx + 1 : idx - 1));
      indices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { elements, indices };
  }
}

/** Topic of PorterVault.ShieldNoteInserted(address,uint96,uint256,uint32). */
export const INSERTED_TOPIC = keccak256(
  toUtf8Bytes("ShieldNoteInserted(address,uint96,uint256,uint32)")
);

/**
 * Every leaf in the vault's native note tree, in insertion order.
 *
 * The vault keeps only the tree's frontier, so the leaves come from its events.
 * An insert sent from a Polkadot app account — which is how a payee inserts —
 * leaves no Ethereum log at all (pool.ts), so the count is checked against the
 * vault's own `nextNoteIndex()` and any missing block is read from Substrate.
 */
export async function noteLeaves(
  provider: Provider,
  vaultAddress: string,
  fromBlock: number,
  fromSubstrate: (
    block: number
  ) => Promise<{ topics: string[]; data: string }[]>
): Promise<bigint[]> {
  const vault = new Contract(
    vaultAddress,
    ["function nextNoteIndex() view returns (uint32)"],
    provider
  );
  const head = await provider.getBlockNumber();
  const found = new Map<number, bigint>();
  const take = (data: string) => {
    // data = commitment (32 bytes) then index (32 bytes)
    found.set(
      Number(toBigInt("0x" + data.slice(66, 130))),
      toBigInt(data.slice(0, 66))
    );
  };
  for (const l of await provider.getLogs({
    address: vaultAddress,
    topics: [INSERTED_TOPIC],
    fromBlock,
    toBlock: head,
  })) {
    take(l.data);
  }
  const size = async (b: number) =>
    Number(await vault.nextNoteIndex({ blockTag: b }));
  const expected = await size(head);
  if (found.size < expected) {
    // Find the blocks that grew the tree but left no log, and read them whole.
    const search = async (a: number, b: number): Promise<void> => {
      const grew = (await size(b)) - (await size(a - 1));
      if (grew === 0) return;
      if (a === b) {
        for (const e of await fromSubstrate(a))
          if (e.topics[0] === INSERTED_TOPIC) take(e.data);
        return;
      }
      const m = (a + b) >> 1;
      await search(a, m);
      await search(m + 1, b);
    };
    await search(fromBlock, head);
  }
  const leaves: bigint[] = [];
  for (let i = 0; i < expected; i++) {
    const leaf = found.get(i);
    if (leaf === undefined)
      throw new Error(`the vault's note ${i} is missing from its events`);
    leaves.push(leaf);
  }
  return leaves;
}

export interface SpendProof {
  /** ABI-encoded (uint256[2], uint256[4], uint256[2]), as the verifier takes it. */
  proof: string;
  root: string;
  nullifierHash: string;
  bucket: string;
  ksCommitment: string;
}

/** Where the circuit and key come from: the app fetches them next to itself, tests read files. */
export interface SpendArtifacts {
  wasm: string | Uint8Array;
  zkey: string | Uint8Array;
}

/** Prove ownership of `note` and bind the pool commitment the deposit must fund. */
export async function proveSpend(
  note: PayoutNote,
  leaves: bigint[],
  ksCommitment: bigint,
  artifacts: SpendArtifacts = { wasm: WASM, zkey: ZKEY }
): Promise<SpendProof> {
  const commitment = payoutCommitment(note);
  const index = leaves.findIndex((l) => l === commitment);
  if (index < 0) throw new Error("this note isn't in the vault's tree yet");
  if (ksCommitment >= BN254_R) throw new Error("commitment out of field");

  const tree = new NoteTree(leaves);
  const { elements, indices } = tree.path(index);
  const snarkjs = await import("snarkjs");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      root: tree.root().toString(),
      nullifierHash: payoutNullifierHash(note).toString(),
      bucket: note.bucket,
      ksCommitment: ksCommitment.toString(),
      nullifier: note.nullifier,
      secret: note.secret,
      pathElements: elements.map(String),
      pathIndices: indices,
    },
    artifacts.wasm as never,
    artifacts.zkey as never
  );
  return {
    proof: AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[4]", "uint256[2]"],
      [
        [proof.pi_a[0], proof.pi_a[1]],
        [
          proof.pi_b[0][1],
          proof.pi_b[0][0],
          proof.pi_b[1][1],
          proof.pi_b[1][0],
        ],
        [proof.pi_c[0], proof.pi_c[1]],
      ]
    ),
    root: publicSignals[0],
    nullifierHash: publicSignals[1],
    bucket: note.bucket,
    ksCommitment: toBeHex(ksCommitment, 32),
  };
}

// ── the two steps, as the app runs them ──────────────────────────────────────

/** The vault's payout buckets, ascending. */
export async function buckets(
  provider: Provider,
  vaultAddress: string
): Promise<bigint[]> {
  const vault = new Contract(
    vaultAddress,
    [
      "function shieldBucketCount() view returns (uint256)",
      "function shieldBuckets(uint256) view returns (uint96)",
    ],
    provider
  );
  const n = Number(await vault.shieldBucketCount());
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) out.push(BigInt(await vault.shieldBuckets(i)));
  return out.sort((a, b) => (a < b ? -1 : 1));
}

/** The largest bucket a balance covers, or null. */
export const bucketFor = (balance: bigint, all: bigint[]): bigint | null =>
  [...all].reverse().find((b) => b <= balance) ?? null;
