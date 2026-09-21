// Note selection, tested against the exact wall a real phone hit:
//
//   57.61 PAS shielded, asked for 25, told "no single note holds 26.6 PAS".
//
// The buckets are 1, 5, 25 and 100. With a fee on top, asking for a round
// bucket amount could never succeed, because the fee always pushed the
// requirement past the largest note. Every test below that mentions 25 is
// about that.

import { describe, expect, it } from "vitest";
import { describePlan, maxWithdrawable, planWithdrawal } from "./plan";

const PAS = (n: string) => BigInt(Math.round(Number(n) * 1e18));
/** 4x a 400k-gas withdrawal at Paseo's 1e12 wei a unit. */
const CEILING = PAS("1.6");

const notes = (...values: string[]) =>
  values.map((v, n) => ({ n, value: PAS(v).toString() }));

describe("the wall this removes", () => {
  it("covers 25 from a 25 and a 5, which the old rule refused outright", () => {
    // The reported case: 25 + 5 + ... = 57.61 shielded, biggest note 25.
    const plan = planWithdrawal(PAS("25"), notes("25", "25", "5", "1", "1"), CEILING)!;
    expect(plan).not.toBe(null);
    // Two notes, so two fees, so the target is 25 + 2 x 1.6.
    expect(plan.notes.length).toBe(2);
    expect(plan.total).toBe(PAS("28.2"));
    expect(plan.fees).toBe(PAS("3.2"));
  });

  it("still refuses to pretend when the notes genuinely cannot cover it", () => {
    expect(planWithdrawal(PAS("100"), notes("5", "1"), CEILING)).toBe(null);
  });

  it("uses one note when one will do, because every extra costs a fee", () => {
    const plan = planWithdrawal(PAS("10"), notes("25", "5", "5"), CEILING)!;
    expect(plan.notes.length).toBe(1);
    expect(plan.total).toBe(PAS("11.6"));
  });
});

describe("the target moves with the plan", () => {
  it("charges a fee per note, not per withdrawal request", () => {
    // 7 + 2 x 1.6 = 10.2, and the two notes hold exactly 10 — not enough.
    expect(planWithdrawal(PAS("7"), notes("5", "5"), CEILING)).toBe(null);
  });

  it("does not return a plan that is short by exactly the fees", () => {
    // The bug one rung down: selecting until the notes cover `amount` while
    // forgetting that each spend also has to pay its own submitter.
    for (const amount of ["1", "4", "9", "24", "26"]) {
      const plan = planWithdrawal(PAS(amount), notes("25", "5", "1"), CEILING);
      if (!plan) continue;
      const have = plan.notes.reduce((a, n) => a + BigInt(n.value), 0n);
      expect(have).toBeGreaterThanOrEqual(plan.amount + plan.fees);
      expect(plan.total).toBe(plan.amount + plan.fees);
    }
  });
});

describe("how much comes from each note", () => {
  it("draws sum to the total", () => {
    const plan = planWithdrawal(PAS("25"), notes("25", "5", "1"), CEILING)!;
    expect(plan.draws.reduce((a, d) => a + d, 0n)).toBe(plan.total);
  });

  it("never takes more from a note than it holds", () => {
    const plan = planWithdrawal(PAS("28"), notes("25", "5", "5"), CEILING)!;
    plan.notes.forEach((note, i) => {
      expect(plan.draws[i]).toBeLessThanOrEqual(BigInt(note.value));
    });
  });

  it("leaves change on at most one note, so the book does not fragment", () => {
    const plan = planWithdrawal(PAS("28"), notes("25", "25", "5"), CEILING)!;
    const partial = plan.notes.filter(
      (note, i) => plan.draws[i] < BigInt(note.value)
    );
    expect(partial.length).toBeLessThanOrEqual(1);
  });

  it("drops a note that would contribute nothing", () => {
    // Largest-first can cover the target before the list runs out; a note
    // drawn at zero would be a withdrawal, a fee and a wait for no money.
    const plan = planWithdrawal(PAS("1"), notes("25", "5", "1"), CEILING)!;
    expect(plan.notes.length).toBe(1);
    expect(plan.draws.every((d) => d > 0n)).toBe(true);
  });
});

describe("the most that can come out", () => {
  it("is everything less one fee per note spent", () => {
    // 25 + 5 = 30, two notes, two fees.
    expect(maxWithdrawable(notes("25", "5"), CEILING)).toBe(PAS("26.8"));
  });

  it("ignores notes that cost more to spend than they hold", () => {
    // A 1 PAS note against a 1.6 PAS fee makes the answer worse, so the best
    // plan leaves it behind rather than including it.
    const dust = maxWithdrawable(notes("25", "1"), CEILING);
    const alone = maxWithdrawable(notes("25"), CEILING);
    expect(dust).toBe(alone);
    expect(dust).toBe(PAS("23.4"));
  });

  it("is zero when nothing can profitably come out", () => {
    expect(maxWithdrawable(notes("1"), CEILING)).toBe(0n);
    expect(maxWithdrawable([], CEILING)).toBe(0n);
  });

  it("agrees with planWithdrawal at the boundary", () => {
    // Whatever this says is possible must actually plan, or a "take out
    // everything" button would offer an amount that then fails.
    const held = notes("25", "25", "5", "1", "1");
    const max = maxWithdrawable(held, CEILING);
    expect(planWithdrawal(max, held, CEILING)).not.toBe(null);
    expect(planWithdrawal(max + PAS("0.01"), held, CEILING)).toBe(null);
  });
});

describe("what a person is told", () => {
  it("says one withdrawal when that is what it is", () => {
    const plan = planWithdrawal(PAS("10"), notes("25"), CEILING)!;
    expect(describePlan(plan)).toBe("One withdrawal.");
  });

  it("names the linkage when more than one note is spent", () => {
    // The privacy cost of a multi-note plan is that those notes become
    // visibly one person's. Saying it is the whole point of this function.
    const plan = planWithdrawal(PAS("25"), notes("25", "5"), CEILING)!;
    expect(describePlan(plan)).toContain("linked to each other");
    expect(describePlan(plan)).toContain("2 withdrawals");
  });
});

describe("refusals", () => {
  it("refuses zero and negative amounts rather than planning nothing", () => {
    expect(planWithdrawal(0n, notes("25"), CEILING)).toBe(null);
    expect(planWithdrawal(-1n, notes("25"), CEILING)).toBe(null);
  });

  it("refuses when there are no notes at all", () => {
    expect(planWithdrawal(PAS("1"), [], CEILING)).toBe(null);
  });
});
