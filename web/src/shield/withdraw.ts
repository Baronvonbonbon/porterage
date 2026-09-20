// Spending a note (docs/PLAN.md §5.3): a Groth16 proof that sends part of a
// note to a recipient and puts the rest back in the pool as a change note.
//
// The customer only PROVES. Someone else submits the proof (funding.ts), because
// whoever sends the transaction is visible, and the recipient is a fresh burner
// that must not be linked to anyone. The recipient is bound into the proof
// (`context`), so the submitter can't redirect the money.
//
// The circuit and keys are Kusama Shield's published withdraw_v7, as FARE used
// them. The 32.8 MiB proving key ships with the app in three parts and is
// checked against its SHA-256 before use.

import type { Provider } from "ethers";
import {
  contextFor,
  reconstructPath,
  type BlockInserts,
  type Note,
  type NotePath,
} from "./pool";

export interface WithdrawalProof {
  pA: [string, string];
  pB: [[string, string], [string, string]];
  pC: [string, string];
  pubSignals: string[];
  recipient: string;
}

/** How the proving artifacts are fetched: the app fetches them next to itself; tests read files. */
export type ArtifactSource = (name: string) => Promise<Uint8Array>;

export const fetchArtifact: ArtifactSource = async (name) => {
  const res = await fetch(`./shield/${name}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

interface Manifest {
  bytes: number;
  sha256: string;
  parts: { name: string; bytes: number }[];
}

const hexOf = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

let cache: Promise<{ wasm: Uint8Array; zkey: Uint8Array }> | null = null;

/** The circuit and proving key, fetched once and verified. A failure clears the cache so the next try refetches. */
export function loadArtifacts(get: ArtifactSource = fetchArtifact) {
  return (cache ??= (async () => {
    const manifest = JSON.parse(
      new TextDecoder().decode(await get("withdraw_v7.zkey.json"))
    ) as Manifest;
    const [wasm, ...parts] = await Promise.all([
      get("withdraw_v7.wasm"),
      ...manifest.parts.map((p) => get(p.name)),
    ]);
    const zkey = new Uint8Array(manifest.bytes);
    let off = 0;
    for (const p of parts) {
      zkey.set(p, off);
      off += p.length;
    }
    if (off !== manifest.bytes)
      throw new Error(`proving key: ${off} bytes, expected ${manifest.bytes}`);
    const digest = hexOf(
      await crypto.subtle.digest("SHA-256", zkey as BufferSource)
    );
    if (digest !== manifest.sha256)
      throw new Error("proving key: checksum mismatch");
    return { wasm, zkey };
  })()).catch((e) => {
    cache = null;
    throw e;
  });
}

/**
 * Prove a withdrawal of `withdrawnValue` from `note` to `recipient`, leaving
 * `change` (value = note − withdrawn, same asset) as the note's replacement.
 */
export async function proveWithdrawal(args: {
  provider: Provider;
  pool: string;
  note: Note;
  path: NotePath;
  change: Note;
  recipient: string;
  withdrawnValue: bigint;
  fromSubstrate: BlockInserts;
  artifacts?: ArtifactSource;
}): Promise<WithdrawalProof> {
  const { note, change, withdrawnValue, recipient } = args;
  if (withdrawnValue <= 0n || withdrawnValue > BigInt(note.value))
    throw new Error("withdrawal must be within the note's value");
  if (BigInt(change.value) !== BigInt(note.value) - withdrawnValue)
    throw new Error("change must be the note's remainder");
  if (change.asset !== note.asset)
    throw new Error("change must be in the note's asset");

  const [{ siblings, root }, { wasm, zkey }, snarkjs] = await Promise.all([
    reconstructPath(
      args.provider,
      args.pool,
      note,
      args.path,
      args.fromSubstrate
    ),
    loadArtifacts(args.artifacts),
    import("snarkjs"),
  ]);
  const input = {
    withdrawnValue: withdrawnValue.toString(),
    treeDepth: "128",
    context: contextFor(recipient).toString(),
    root,
    asset: note.asset,
    existingValue: note.value,
    existingNullifier: note.nullifier,
    existingSecret: note.secret,
    newNullifier: change.nullifier,
    newSecret: change.secret,
    siblings,
    leafIndex: args.path.index.toString(),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    wasm as never,
    zkey as never
  );
  return {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    pC: [proof.pi_c[0], proof.pi_c[1]],
    pubSignals: publicSignals,
    recipient,
  };
}
