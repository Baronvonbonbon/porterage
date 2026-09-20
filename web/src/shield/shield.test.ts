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

import { REQUEST_BYTES, decodeRequest, encodeRequest } from "../market/request";
import { contextFor } from "./pool";
import { decodeStatement } from "../market/scale";

describe("funding request", () => {
  const recipient = "0x329abA8a30B10E13bfb9f6dD28d0dc34ceDb92a8";
  const withdrawn = 13n * 10n ** 17n;
  const proof = {
    recipient,
    pA: ["1", "2"] as [string, string],
    pB: [["3", "4"], ["5", "6"]] as [[string, string], [string, string]],
    pC: ["7", "8"] as [string, string],
    pubSignals: ["101", "102", "103", withdrawn.toString(), "128", contextFor(recipient).toString(), "107", "0"],
  };

  it("round-trips in 426 bytes, restoring the derived signals", () => {
    const bytes = encodeRequest({ proof, withdrawn, fee: 3n * 10n ** 17n });
    expect(bytes.length).toBe(REQUEST_BYTES);
    const back = decodeRequest(bytes);
    expect(back.proof).toEqual(proof);
    expect(back.withdrawn).toBe(withdrawn);
    expect(back.fee).toBe(3n * 10n ** 17n);
  });

  it("refuses a proof whose signals disagree with the request", () => {
    expect(() => encodeRequest({ proof, withdrawn: withdrawn + 1n, fee: 0n })).toThrow();
  });
});

describe("statement decoding", () => {
  it("reads topics, channel, expiry and data", () => {
    const topic = new Uint8Array(32).fill(7);
    const channel = new Uint8Array(32).fill(9);
    const data = new Uint8Array(300).fill(5);
    const expiry = (1_800_000_000n << 32n) | 3n;
    const le = (v: bigint) => Uint8Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
    const bytes = new Uint8Array([
      5 << 2, // five fields
      0, 0, ...new Uint8Array(96), // sr25519 proof
      2, ...le(expiry),
      3, ...channel,
      4, ...topic,
      8, ((300 << 2) | 1) & 0xff, (300 << 2 | 1) >> 8, ...data,
    ]);
    const s = decodeStatement(bytes);
    expect(s.topics).toEqual([topic]);
    expect(s.channel).toEqual(channel);
    expect(s.expiry).toBe(expiry);
    expect(s.data).toEqual(data);
  });
});

import { PAYOUT_BYTES, decodePayout, encodePayout } from "../market/request";
import { NoteTree, payoutCommitment, payoutNullifierHash, zeroHashes } from "./payout";

describe("payout notes", () => {
  const note = { n: 3, bucket: (5n * PAS).toString(), nullifier: "12345", secret: "67890" };

  it("bind the bucket into the leaf", () => {
    expect(payoutCommitment(note)).not.toBe(payoutCommitment({ ...note, bucket: PAS.toString() }));
    expect(payoutNullifierHash(note)).toBe(payoutNullifierHash({ ...note, bucket: PAS.toString() }));
  });

  it("build a path that reproduces the tree's root", () => {
    const leaves = Array.from({ length: 5 }, (_, i) => payoutCommitment({ ...note, nullifier: String(i + 1) }));
    const tree = new NoteTree(leaves);
    const zeros = zeroHashes();
    for (let index = 0; index < leaves.length; index++) {
      const { elements, indices } = tree.path(index);
      let node = leaves[index];
      for (let lv = 0; lv < elements.length; lv++) {
        const sibling = elements[lv];
        node = indices[lv] === 0 ? poseidon2([node, sibling]) : poseidon2([sibling, node]);
      }
      expect(node).toBe(tree.root());
    }
    expect(new NoteTree([]).root()).toBe(zeros[16]);
  });

  it("round-trip a payout request in 366 bytes", () => {
    const req = {
      bucket: 5n * PAS,
      root: "12345678901234567890",
      nullifierHash: "987654321",
      ksCommitment: "0x" + "ab".repeat(32),
      words: ["1", "2", "3", "4", "5", "6", "7", "8"],
    };
    const bytes = encodePayout(req);
    expect(bytes.length).toBe(PAYOUT_BYTES);
    expect(decodePayout(bytes)).toEqual(req);
  });
});

import { MAX_NOTES_PER_TAP, planTopUp } from "./deposit";
import { formatUnits, parseUnits, TOKENS } from "../money/tokens";
import { precompileFor } from "./pool";

describe("top-up plans", () => {
  it("shield at most the notes that fit in one transaction, biggest first", () => {
    const plan = planTopUp(131n * PAS);
    expect(plan.rungs).toEqual([100n * PAS, 25n * PAS, 5n * PAS]);
    expect(plan.rungs.length).toBeLessThanOrEqual(MAX_NOTES_PER_TAP);
    expect(plan.leftOver).toBe(PAS);
    expect(planTopUp(6n * PAS)).toMatchObject({ rungs: [5n * PAS, PAS], leftOver: 0n });
  });
});

describe("tokens", () => {
  it("list the precompile the pool derives for each asset", () => {
    for (const t of TOKENS) {
      expect(t.precompile.toLowerCase()).toBe("0x" + precompileFor(BigInt(t.id)).toString(16).padStart(40, "0"));
    }
  });

  it("parse and format amounts at the asset's decimals", () => {
    expect(parseUnits("12.345678", 6)).toBe(12_345_678n);
    expect(parseUnits("0.5", 6)).toBe(500_000n);
    expect(parseUnits("", 6)).toBe(null);
    expect(parseUnits("abc", 6)).toBe(null);
    expect(formatUnits(12_345_678n, 6, 4)).toBe("12.3456");
  });
});
