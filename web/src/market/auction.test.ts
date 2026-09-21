// The price curve and the claim back-off.
//
// These are cheap tests of arithmetic, and they are here because the
// arithmetic decides what strangers get paid. A floor that can sag below cost
// means submitters quietly stop showing up; a ceiling that can be exceeded
// means a customer can be charged anything.

import { describe, expect, it } from "vitest";
import { Wallet } from "ethers";
import {
  CLAIM_BYTES,
  CLAIM_TTL_S,
  Claims,
  MAX_MARGIN_BPS,
  MIN_MARGIN_BPS,
  decodeClaim,
  encodeClaim,
  priceAt,
  scheduleFor,
  worthDoing,
} from "./auction";

const GAS = 10n ** 15n; // a plausible withdrawal cost in wei

describe("the price schedule", () => {
  const s = scheduleFor(GAS, 1000, 30);

  it("opens at the floor and ends at the ceiling", () => {
    expect(priceAt(s, 1000)).toBe(s.floor);
    expect(priceAt(s, 1030)).toBe(s.ceiling);
  });

  it("is the stated multiple of gas at each end", () => {
    expect(s.floor).toBe((GAS * MIN_MARGIN_BPS) / 10_000n);
    expect(s.ceiling).toBe((GAS * MAX_MARGIN_BPS) / 10_000n);
  });

  it("rises, and never falls", () => {
    let last = -1n;
    for (let t = 995; t <= 1035; t++) {
      const p = priceAt(s, t);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });

  it("never goes below the floor, however early anyone asks", () => {
    // A submitter with a clock running behind the requester's must not be able
    // to see a price under the floor and take the job below cost.
    expect(priceAt(s, 0)).toBe(s.floor);
    expect(priceAt(s, -99999)).toBe(s.floor);
  });

  it("never goes above the ceiling, however late anyone asks", () => {
    // This is the customer's protection, and it is the one that matters if a
    // request sits unanswered for an hour.
    expect(priceAt(s, 1_000_000)).toBe(s.ceiling);
    expect(priceAt(s, 10 ** 12)).toBe(s.ceiling);
  });

  it("is halfway up at halfway through", () => {
    expect(priceAt(s, 1015)).toBe(s.floor + (s.ceiling - s.floor) / 2n);
  });

  it("offers the ceiling at once when there is no climb", () => {
    // How a pre-market record is paid: a flat fee is a schedule that has
    // already finished climbing.
    const flat = { floor: 7n, ceiling: 7n, startedAt: 0, climbSecs: 0 };
    expect(priceAt(flat, 0)).toBe(7n);
    expect(priceAt(flat, 9999)).toBe(7n);
  });

  it("refuses a negative gas cost rather than inventing a schedule", () => {
    expect(() => scheduleFor(-1n)).toThrow();
  });

  it("clears a 1.5x operator immediately and a 4x operator only at the end", () => {
    // The whole mechanism in one assertion: the cheapest operator takes the
    // job first, the dearest last, and nobody has to be asked.
    const lean = worthDoing(GAS, MIN_MARGIN_BPS);
    const fat = worthDoing(GAS, MAX_MARGIN_BPS);
    expect(priceAt(s, 1000)).toBeGreaterThanOrEqual(lean);
    expect(priceAt(s, 1000)).toBeLessThan(fat);
    expect(priceAt(s, 1030)).toBeGreaterThanOrEqual(fat);
  });
});

describe("claims", () => {
  const a = new Wallet(Wallet.createRandom().privateKey).address;
  const b = new Wallet(Wallet.createRandom().privateKey).address;
  const key = "12345678901234567890";

  it("round-trips through the statement encoding", () => {
    const bytes = encodeClaim({ key, claimant: a });
    expect(bytes.length).toBe(CLAIM_BYTES);
    const back = decodeClaim(bytes)!;
    expect(BigInt(back.key)).toBe(BigInt(key));
    expect(back.claimant).toBe(a);
  });

  it("rejects a malformed claim rather than throwing", () => {
    expect(decodeClaim(new Uint8Array(10))).toBe(null);
    expect(decodeClaim(new Uint8Array(CLAIM_BYTES))).toBe(null); // version 0
  });

  it("matches a decimal key against the hex the chain returns", () => {
    // The circuit hands out decimal strings and the chain hex. If these did
    // not normalise to the same thing, every claim would silently miss.
    const claims = new Claims();
    claims.heard({ key, claimant: a }, 100);
    const hex = "0x" + BigInt(key).toString(16).padStart(64, "0");
    expect(claims.heldByOther(hex, b, 100)).toBe(a);
  });

  it("reports someone else's live claim, and not my own", () => {
    const claims = new Claims();
    claims.heard({ key, claimant: a }, 100);
    expect(claims.heldByOther(key, b, 100)).toBe(a);
    expect(claims.heldByOther(key, a, 100)).toBe(null);
  });

  it("lets a claim expire, so a submitter that quits doesn't freeze the job", () => {
    const claims = new Claims();
    claims.heard({ key, claimant: a }, 100);
    expect(claims.heldByOther(key, b, 100 + CLAIM_TTL_S - 1)).toBe(a);
    expect(claims.heldByOther(key, b, 100 + CLAIM_TTL_S)).toBe(null);
  });

  it("does not let a straggler displace a live claim", () => {
    // Otherwise a late claim would take a job someone is already paying gas
    // for, which is exactly the collision this is meant to prevent.
    const claims = new Claims();
    claims.heard({ key, claimant: a }, 100);
    claims.heard({ key, claimant: b }, 105);
    expect(claims.heldByOther(key, b, 105)).toBe(a);
  });

  it("lets a new claim take over once the old one has expired", () => {
    const claims = new Claims();
    claims.heard({ key, claimant: a }, 100);
    claims.heard({ key, claimant: b }, 100 + CLAIM_TTL_S);
    expect(claims.heldByOther(key, a, 100 + CLAIM_TTL_S)).toBe(b);
  });
});
