// What can be sent on, and what the app refuses to pretend.
//
// The arithmetic here is small but it is the last thing standing between a
// person and an empty account: send the whole balance and the transfer has no
// gas to pay for itself, so it fails after they have already agreed to give up
// the unlinkability.

import { describe, expect, it } from "vitest";
import { sendableOf } from "./cashout";

const PAS = (n: string) => BigInt(Math.round(Number(n) * 1e18));

describe("what a kept account can send on", () => {
  it("holds back enough to pay for the send itself", () => {
    const balance = PAS("1");
    expect(sendableOf(balance)).toBeLessThan(balance);
    expect(sendableOf(balance)).toBe(balance - PAS("0.02"));
  });

  it("offers nothing when the balance cannot cover its own gas", () => {
    // Better to say "not enough here" than to send a transaction that reverts
    // after the person has already accepted the privacy cost.
    expect(sendableOf(PAS("0.02"))).toBe(0n);
    expect(sendableOf(PAS("0.01"))).toBe(0n);
    expect(sendableOf(0n)).toBe(0n);
  });

  it("never returns a negative, whatever the balance", () => {
    for (const b of [0n, 1n, PAS("0.019"), PAS("0.02"), PAS("100")]) {
      expect(sendableOf(b)).toBeGreaterThanOrEqual(0n);
    }
  });

  it("scales with the balance rather than capping it", () => {
    // A cash-out of 100 PAS should send ~100 PAS, not a fixed slice.
    expect(sendableOf(PAS("100"))).toBe(PAS("100") - PAS("0.02"));
  });
});
