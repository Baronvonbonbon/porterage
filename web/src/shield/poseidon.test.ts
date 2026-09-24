// Poseidon must never quietly change.
//
// Every shielded note's commitment and nullifier is a Poseidon hash, and so is
// every node of the vault's note tree and every drop commitment on chain. If
// this function starts returning different numbers, notes already in the tree
// stop being findable, nullifiers stop matching, and the money behind them is
// stranded — with nothing failing loudly at the moment it happens.
//
// The existing suites hash and re-hash with the same import, so they agree
// with themselves whatever it returns. That is the gap this closes: these are
// fixed vectors, and they were computed from `poseidon-lite`'s package barrel
// before the imports were changed to its per-arity entry points to keep 609 kB
// of unused round constants out of the bundle. Identical, which is the whole
// claim being made here.
//
// A failure here is not a formatting problem. It means the hash changed, and
// every note that exists was committed under the old one.

import { describe, expect, it } from "vitest";
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { positionCommit, dropNullifier } from "../order/geo";

describe("poseidon", () => {
  it("hashes one input to the value the tree was built with", () => {
    expect(poseidon1([0n])).toBe(
      19014214495641488759237505126948346942972912379615652741039992445865937985820n
    );
    expect(poseidon1([1n])).toBe(
      18586133768512220936620570745912940619677854269274689475585506675881198879027n
    );
  });

  it("hashes two inputs the same — every tree node depends on this", () => {
    expect(poseidon2([0n, 0n])).toBe(
      14744269619966411208579211824598458697587494354926760081771325075741142829156n
    );
    expect(poseidon2([1n, 2n])).toBe(
      7853200120776062878684798364095072458815029376092732009249414926327459813530n
    );
  });

  it("hashes three inputs the same — every drop commitment depends on this", () => {
    expect(poseidon3([1n, 2n, 3n])).toBe(
      6542985608222806190361240322586112750744169038454362455181422643027100751666n
    );
  });
});

describe("what the app builds on it", () => {
  it("commits a position to the value the contracts were given", () => {
    // 37.7749, -122.4194 — the coordinates every fixture in this repo uses —
    // offset into the field as geo.ts does it, with a fixed salt.
    expect(positionCommit({ lat: 37_774_900, lon: -122_419_400 }, 42n)).toBe(
      21127761106602078491253019537109758991019930132290894700131564650000599802116n
    );
  });

  it("derives a drop nullifier that a settled order would still match", () => {
    expect(dropNullifier(42n, 1n)).toBe(poseidon2([42n, 1n]));
  });
});
