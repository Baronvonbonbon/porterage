// Can a shop still be found once newer ones exist?
//
// `allVenues` reads ids downwards from the newest and stops at a limit. The
// limit used to count IDS VISITED, which quietly made it a rule about who gets
// to be seen: twenty test venues took ids 16–35, and venue #6 — the only real
// one on the chain, registered long before them — stopped appearing for
// anybody. Nothing failed. The list was full, the app was fine, and the shop
// was gone.
//
// So the limit counts venues KEPT, and a closed venue is skipped rather than
// counted. These are the two halves of that, plus the paging, because reading
// thirty-five venues one round trip at a time is its own kind of broken.

import { describe, expect, it, vi } from "vitest";

const venues = new Map<number, { active: boolean }>();
let reads = 0;

vi.mock("../contracts", () => ({
  read: () => ({
    nextVenueId: async () => BigInt(Math.max(...venues.keys(), 0) + 1),
    venues: async (id: bigint) => {
      reads++;
      // An id nobody registered reads back as a zero struct, not a revert —
      // solidity mappings have no absent case. So an unknown venue is simply
      // one that is not active, which is what the contract would say.
      const v = venues.get(Number(id));
      return {
        operator: "0x1",
        signer: "0x2",
        payout: "0x3",
        lat: 0,
        lon: 0,
        active: v?.active ?? false,
        pickups: 0,
        metadataURI: "",
      };
    },
  }),
  readAt: () => ({}),
  addressOf: () => "0x0",
  ABI: { venues: {} },
  writable: () => ({}),
  hostCall: vi.fn(),
}));

const { allVenues } = await import("./venue");

/**
 * Ids count up from 1 with no gaps, as they do on chain. `open` are trading;
 * every other id up to the highest is registered but closed.
 */
function chain(open: number[], highest = Math.max(...open)) {
  venues.clear();
  reads = 0;
  for (let id = 1; id <= highest; id++)
    venues.set(id, { active: open.includes(id) });
}

describe("allVenues", () => {
  it("finds an old venue behind a wall of newer ones", async () => {
    // Exactly the shape that hid it: #6 real, 16–35 from the harness.
    chain([6, ...Array.from({ length: 20 }, (_, i) => 16 + i)]);
    const found = await allVenues(24);
    expect(found.map((v) => Number(v.id))).toContain(6);
  });

  it("does not spend the limit on closed venues", async () => {
    chain([6], 35);
    const found = await allVenues(5);
    expect(found.map((v) => Number(v.id))).toEqual([6]);
  });

  it("keeps closed ones when asked, for an operator's own list", async () => {
    chain([1, 2, 3], 5);
    const found = await allVenues(10, { closed: true });
    expect(found.map((v) => Number(v.id))).toEqual([5, 4, 3, 2, 1]);
  });

  it("stops once it has enough, rather than reading the whole chain", async () => {
    chain(Array.from({ length: 200 }, (_, i) => i + 1));
    const found = await allVenues(3);
    expect(found).toHaveLength(3);
    // One page of twelve, not two hundred reads.
    expect(reads).toBeLessThanOrEqual(12);
  });

  it("returns newest first", async () => {
    chain([1, 2, 3]);
    expect((await allVenues(10)).map((v) => Number(v.id))).toEqual([3, 2, 1]);
  });
});
