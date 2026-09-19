import { describe, expect, it } from "vitest";
import { poseidon2 } from "poseidon-lite";
import { LADDER_PAS, cover, decompose, sum } from "./ladder";
import { authPath, batchNotePaths, commitmentOf, rootFrom } from "./pool";
import { noteSecrets } from "./notes";

const PAS = 10n ** 18n;

describe("ladder", () => {
  it("covers an amount with fixed rungs, rounding up", () => {
    const { rungs, overshoot } = cover(12n * PAS, LADDER_PAS);
    expect(rungs).toEqual([5n * PAS, 5n * PAS, 1n * PAS, 1n * PAS]);
    expect(overshoot).toBe(0n);
    expect(sum(rungs) - 12n * PAS).toBe(overshoot);
    expect(cover(PAS / 2n, LADDER_PAS)).toEqual({ rungs: [PAS], overshoot: PAS / 2n });
  });
  it("decomposes, leaving the residue", () => {
    expect(decompose(131n * PAS + 1n, LADDER_PAS)).toEqual({
      rungs: [100n * PAS, 25n * PAS, 5n * PAS, 1n * PAS],
      residue: 1n,
    });
  });
});

describe("note secrets", () => {
  it("are fixed by the entropy and differ between notes", () => {
    const a = noteSecrets(new Uint8Array(32).fill(1));
    expect(noteSecrets(new Uint8Array(32).fill(1))).toEqual(a);
    expect(noteSecrets(new Uint8Array(32).fill(2)).nullifier).not.toBe(a.nullifier);
    expect(a.nullifier).not.toBe(a.secret);
  });
});

// A reference LeanIMT: the root of a list of leaves, computed directly.
function leanRoot(leaves: bigint[]): bigint {
  let level = leaves;
  while (level.length > 1) {
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? poseidon2([level[i], level[i + 1]]) : level[i]);
    level = next;
  }
  return level[0];
}

describe("paths", () => {
  it("left snapshots plus later leaves reach the tree's root, for every leaf", () => {
    const leaves = Array.from({ length: 13 }, (_, i) =>
      commitmentOf({ nullifier: String(i + 1), secret: String(i + 100), value: String(PAS), asset: "0" }),
    );
    // The tree before any of these, then all 13 inserted as one run.
    const paths = batchNotePaths(0, {}, leaves);
    const root = leanRoot(leaves);
    for (const p of paths) {
      const right = new Map(leaves.map((l, i) => [i, l] as const).filter(([i]) => i > p.index));
      right.set(p.index, leaves[p.index]);
      const siblings = authPath(p.index, p.leftSnapshot, right, leaves.length - 1);
      expect(rootFrom(leaves[p.index], p.index, siblings)).toBe(root);
    }
  });

  it("a run that starts mid-tree matches one built from scratch", () => {
    const leaves = Array.from({ length: 9 }, (_, i) => BigInt(i + 7));
    const all = batchNotePaths(0, {}, leaves);
    // Tree state after the first 5, as side nodes: replay them.
    const side: Record<number, string> = {};
    const s: Record<number, bigint> = {};
    leaves.slice(0, 5).forEach((leaf, index) => {
      let node = leaf;
      for (let lv = 0; lv < 8; lv++) {
        if ((index >> lv) & 1) node = s[lv] ? poseidon2([s[lv], node]) : node;
        else s[lv] = node;
      }
    });
    for (const k in s) side[k] = s[k].toString();
    expect(batchNotePaths(5, side, leaves.slice(5))).toEqual(all.slice(5));
  });
});
