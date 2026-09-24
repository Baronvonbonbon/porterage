// Kusama Shield pool client (docs/PLAN.md §5.1–5.3), ported from FARE's
// web/src/shieldpool.ts, where it ran end to end on Paseo on 2026-07-24.
//
// Porterage deposits from the user's host account (a Substrate Revive.call, one
// tap for any number of notes), so the deposit itself lives in deposit.ts. What
// stays here is the pool's arithmetic: commitments, the Merkle path each note
// needs to be spent, and the withdrawal proof.
//
// A note's path has two halves. The LEFT half (siblings at the levels where the
// note's index has a 1 bit) is fixed the moment the note is inserted, so it is
// captured once, from the tree state just before the deposit's block, and kept.
// The RIGHT half is rebuilt at spend time from the inserts that came after it.
// Neither needs the pool's genesis leaf or a full-history scan.
//
// Where the leaves come from matters on Asset Hub. The Ethereum RPC only sees
// Ethereum transactions: a deposit sent as a Substrate Revive.call, which is how
// a Polkadot app account calls a contract, leaves no eth_getLogs entry at all
// (measured 2026-09-19: the tree grew by 2 in block 13456840, which showed no
// transactions and no logs). Its events are in System.Events like any other. So
// leaves are read from the Ethereum logs, each range's count is checked against
// the pool's treeSize at that block, and any block where the tree grew without
// logs is read from the Substrate side instead (`BlockInserts`).

// Per-arity entry points: the barrel costs all sixteen arities' constants.
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import {
  Contract,
  Interface,
  keccak256,
  solidityPacked,
  toBigInt,
  zeroPadValue,
  toBeHex,
  type Provider,
} from "ethers";

export const POOL_ABI = [
  "function depositNative(bytes32 commitment) payable",
  "function depositAsset(uint256 asset, uint256 value, bytes32 commitment)",
  // Both take the same proof and a recipient bound into it, so anyone can submit
  // either. `withdraw` is the cheap one: proxy_withdraw deploys a forwarder
  // (742k gas on Paseo) and conceals nothing more (FARE, 2026-07).
  "function withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function proxy_withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function currentRoot() view returns (uint256)",
  "function treeSize() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
  "event Deposit(address indexed asset, bytes32 commitment)",
  "event NewCommitment(bytes32 commitment)",
];
export const POOL = new Interface(POOL_ABI);

export const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const NATIVE = 0n;
const DEPTH = 128;

export interface Note {
  nullifier: string; // decimal field element
  secret: string;
  value: string; // smallest units of `asset` (wei for PAS)
  /** The pool's key for the asset: 0 for PAS, else the ERC-20 precompile address as a number. */
  asset: string;
}

/** Where a note sits in the tree, and the half of its path that never changes. */
export interface NotePath {
  index: number;
  leftSnapshot: Record<number, string>;
  /** A block at or before the note's insert: the right-side scan starts here. */
  depositBlock: number;
}

export const b32 = (x: bigint): string => zeroPadValue(toBeHex(x), 32);
const bit = (n: number | bigint, lv: number): boolean =>
  ((BigInt(n) >> BigInt(lv)) & 1n) === 1n;

/**
 * The pool's ERC-20 precompile address for an Asset Hub asset id, as the pool
 * derives it: `(assetId << 128) | (0x0120 << 16)`. A note commits to this, not
 * to the id; the deposit CALL takes the id.
 */
export const precompileFor = (assetId: bigint): bigint => {
  if (assetId === NATIVE) return NATIVE;
  if (assetId >= 1n << 64n)
    throw new Error("assetId too large (pool requires < 2^64)");
  return (assetId << 128n) | (0x0120n << 16n);
};

export const commitmentOf = (n: Note): bigint =>
  poseidon2([
    poseidon2([BigInt(n.value), BigInt(n.asset)]),
    poseidon2([BigInt(n.nullifier), BigInt(n.secret)]),
  ]);
export const nullifierHashOf = (n: Note): bigint =>
  poseidon1([BigInt(n.nullifier)]);
export const contextFor = (recipient: string): bigint =>
  toBigInt(keccak256(solidityPacked(["address"], [recipient]))) % BN254_R;

// ── left paths ───────────────────────────────────────────────────────────────

/**
 * Left paths for a run of consecutive inserts, from the tree state just before
 * the first of them (FARE's batchNotePaths). Every left sibling of a run member
 * either lies wholly before the run (in `preSideNodes`) or is built from run
 * members, which are replayed here.
 */
export function batchNotePaths(
  startIndex: number,
  preSideNodes: Record<number, string>,
  commitments: bigint[]
): { index: number; leftSnapshot: Record<number, string> }[] {
  const side: Record<number, bigint> = {};
  for (let lv = 0; lv < DEPTH; lv++) side[lv] = BigInt(preSideNodes[lv] ?? "0");
  return commitments.map((leaf, k) => {
    const index = startIndex + k;
    const leftSnapshot: Record<number, string> = {};
    for (let lv = 0; lv < DEPTH; lv++)
      if (bit(index, lv)) leftSnapshot[lv] = side[lv].toString();
    let node = leaf;
    for (let lv = 0; lv < DEPTH; lv++) {
      if (bit(index, lv)) {
        if (side[lv] !== 0n) node = poseidon2([side[lv], node]);
      } else side[lv] = node;
    }
    return { index, leftSnapshot };
  });
}

const INSERT_TOPICS = [
  "Deposit(address,bytes32)",
  "NewCommitment(bytes32)",
].map((s) => keccak256(solidityPacked(["string"], [s])));
export const DEPOSIT_TOPIC = INSERT_TOPICS[0];
export const NEW_COMMITMENT_TOPIC = INSERT_TOPICS[1];

/** Every leaf the pool inserted in one block, in order, from the block's System.Events. */
export type BlockInserts = (block: number) => Promise<bigint[]>;

async function insertLogs(
  provider: Provider,
  pool: string,
  from: number,
  to: number
) {
  const out: { blockNumber: number; index: number; data: string }[] = [];
  const get = async (a: number, b: number): Promise<void> => {
    try {
      for (const topic of INSERT_TOPICS) {
        out.push(
          ...((await provider.getLogs({
            address: pool,
            topics: [topic],
            fromBlock: a,
            toBlock: b,
          })) as never[])
        );
      }
    } catch (e) {
      if (b <= a) throw e;
      const m = (a + b) >> 1;
      await get(a, m);
      await get(m + 1, b);
    }
  };
  await get(from, to);
  out.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
  return out.map((l) => ({
    block: l.blockNumber,
    leaf: toBigInt(l.data.slice(0, 66)),
  }));
}

/**
 * Every leaf inserted in blocks [from, to], in order. Ethereum logs first; then
 * any range whose log count falls short of the tree's growth is bisected down
 * to the blocks responsible, and those blocks are read in full from Substrate.
 */
export async function leavesBetween(
  provider: Provider,
  pool: string,
  from: number,
  to: number,
  fromSubstrate: BlockInserts
): Promise<bigint[]> {
  const read = new Contract(pool, POOL_ABI, provider);
  const sizes = new Map<number, number>();
  const size = async (b: number) => {
    if (!sizes.has(b))
      sizes.set(b, Number(await read.treeSize({ blockTag: b })));
    return sizes.get(b)!;
  };
  const logs = await insertLogs(provider, pool, from, to);
  const byBlock = new Map<number, bigint[]>();
  for (const l of logs)
    byBlock.set(l.block, [...(byBlock.get(l.block) ?? []), l.leaf]);
  const logged = (a: number, b: number) =>
    logs.filter((l) => l.block >= a && l.block <= b).length;

  const check = async (a: number, b: number): Promise<void> => {
    const grew = (await size(b)) - (await size(a - 1));
    if (grew === logged(a, b)) return;
    if (a === b) {
      const leaves = await fromSubstrate(a);
      if (leaves.length !== grew)
        throw new Error(
          `block ${a}: the tree grew by ${grew}, events show ${leaves.length}`
        );
      byBlock.set(a, leaves);
      return;
    }
    const m = (a + b) >> 1;
    await check(a, m);
    await check(m + 1, b);
  };
  await check(from, to);
  return [...byBlock.keys()]
    .sort((x, y) => x - y)
    .flatMap((b) => byBlock.get(b)!);
}

/**
 * Paths for `mine`, inserted in `block`, possibly among other people's inserts
 * in the same block. Reads the tree as it stood at the end of the block before
 * (the Paseo eth-rpc serves historical state), then replays the block's inserts,
 * read from Substrate so that Substrate-sent deposits are included.
 */
export async function notePathsAt(
  provider: Provider,
  pool: string,
  block: number,
  mine: bigint[],
  fromSubstrate: BlockInserts
): Promise<NotePath[]> {
  const read = new Contract(pool, POOL_ABI, provider);
  const before = block - 1;
  const [start, end] = (
    await Promise.all([
      read.treeSize({ blockTag: before }),
      read.treeSize({ blockTag: block }),
    ])
  ).map(Number);
  const inserts = await fromSubstrate(block);
  if (inserts.length !== end - start) {
    throw new Error(
      `block ${block}: the tree grew by ${end - start}, events show ${
        inserts.length
      }`
    );
  }
  const levels = Math.max(1, (end - 1).toString(2).length);
  const pre: Record<number, string> = {};
  const nodes = await Promise.all(
    Array.from(
      { length: levels },
      (_, lv) => read.sideNodes(lv, { blockTag: before }) as Promise<bigint>
    )
  );
  nodes.forEach((v, lv) => (pre[lv] = v.toString()));
  const paths = batchNotePaths(start, pre, inserts);
  return mine.map((c) => {
    const k = inserts.indexOf(c);
    if (k < 0)
      throw new Error(
        `commitment ${b32(c).slice(
          0,
          12
        )}… is not among block ${block}'s inserts`
      );
    return { ...paths[k], depositBlock: before };
  });
}

/**
 * The block a leaf was inserted in, searching from `from`. Ethereum logs first
 * (a peer's withdrawal is an Ethereum transaction); failing that, the blocks
 * where the tree grew are read from Substrate.
 */
export async function findLeafBlock(
  provider: Provider,
  pool: string,
  leaf: bigint,
  from: number,
  fromSubstrate: BlockInserts
): Promise<number | null> {
  const head = await provider.getBlockNumber();
  const hit = (await insertLogs(provider, pool, from, head)).find(
    (l) => l.leaf === leaf
  );
  if (hit) return hit.block;
  const read = new Contract(pool, POOL_ABI, provider);
  const size = async (b: number) =>
    Number(await read.treeSize({ blockTag: b }));
  const search = async (a: number, b: number): Promise<number | null> => {
    if ((await size(b)) === (await size(a - 1))) return null;
    if (a === b) return (await fromSubstrate(a)).includes(leaf) ? a : null;
    const m = (a + b) >> 1;
    return (await search(a, m)) ?? (await search(m + 1, b));
  };
  return search(from, head);
}

// ── right side, at spend time ────────────────────────────────────────────────

/** Root of the subtree covering [start, start + 2^lv) from the known leaves. */
export function subtreeRoot(
  leaves: Map<number, bigint>,
  lv: number,
  start: bigint,
  maxIdx: number
): bigint | null {
  if (start > BigInt(maxIdx)) return null;
  if (lv === 0) {
    const s = Number(start);
    return leaves.has(s) ? leaves.get(s)! : null;
  }
  const half = 1n << BigInt(lv - 1);
  const l = subtreeRoot(leaves, lv - 1, start, maxIdx);
  const r = subtreeRoot(leaves, lv - 1, start + half, maxIdx);
  if (l != null && r != null) return poseidon2([l, r]);
  return l;
}

/** The note's full sibling list: left from the snapshot, right from later inserts. */
export function authPath(
  index: number,
  leftSnapshot: Record<number, string>,
  rightLeaves: Map<number, bigint>,
  maxIdx: number
): string[] {
  const siblings: string[] = [];
  const idx = BigInt(index);
  for (let lv = 0; lv < DEPTH; lv++) {
    if (bit(index, lv)) {
      siblings.push(leftSnapshot[lv] ?? "0");
      continue;
    }
    const start = ((idx >> BigInt(lv)) + 1n) << BigInt(lv);
    const r = subtreeRoot(rightLeaves, lv, start, maxIdx);
    siblings.push(r == null ? "0" : r.toString());
  }
  return siblings;
}

export function rootFrom(
  commitment: bigint,
  index: number,
  siblings: string[]
): bigint {
  let node = commitment;
  for (let lv = 0; lv < DEPTH; lv++) {
    const s = BigInt(siblings[lv]);
    if (s === 0n) continue;
    node = bit(index, lv) ? poseidon2([s, node]) : poseidon2([node, s]);
  }
  return node;
}

/** The note's current path and the live root it proves against. */
export async function reconstructPath(
  provider: Provider,
  pool: string,
  note: Note,
  path: NotePath,
  fromSubstrate: BlockInserts
): Promise<{ siblings: string[]; root: string }> {
  const read = new Contract(pool, POOL_ABI, provider);
  const head = await provider.getBlockNumber();
  const leaves = await leavesBetween(
    provider,
    pool,
    path.depositBlock + 1,
    head,
    fromSubstrate
  );
  // The first leaf of the scan sits at treeSize(depositBlock); anchor on our own commitment.
  const first = Number(await read.treeSize({ blockTag: path.depositBlock }));
  const commit = commitmentOf(note);
  if (leaves[path.index - first] !== commit) {
    throw new Error(
      "the note's commitment isn't where its record says; the note book may be stale"
    );
  }
  const right = new Map<number, bigint>();
  let idx = path.index;
  for (const leaf of leaves.slice(path.index - first)) right.set(idx++, leaf);
  const siblings = authPath(path.index, path.leftSnapshot, right, idx - 1);
  const onchain = (await read.currentRoot({ blockTag: head })) as bigint;
  if (rootFrom(commit, path.index, siblings) !== onchain) {
    throw new Error(
      "the rebuilt path doesn't reach the pool's current root; try again in a block"
    );
  }
  return { siblings, root: onchain.toString() };
}
