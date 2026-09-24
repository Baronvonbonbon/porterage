// An order belongs to the contract it was created on.
//
// Order ids are per-contract and sequential, and the freeze-and-drain upgrade
// model (docs/MIGRATION.md) deliberately keeps two deployments live at once
// while the old one drains. So #7 exists on both, as two unrelated orders.
//
// This is the failure mode that corrupts instead of failing: a customer opens
// their order, the app resolves #7 against whichever contract it currently
// points at, and shows them a stranger's delivery — with a live Cancel button
// on it. Nothing throws. Nothing looks wrong.
//
// So: `OrderRecord.at` is stamped at creation, every customer-side read and
// write takes it, and the second test reads the source to check no call site
// quietly drops it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAt } from "../contracts";
import DEPLOYED from "../deployed.json";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");

/**
 * The argument text of every `fn(...)` call in `code`.
 *
 * A regex cannot do this: the arguments contain their own brackets
 * (`BigInt(live.record.id)`), and a pattern loose enough to span them is loose
 * enough to match the wrong call. So walk the brackets.
 */
function callsTo(code: string, fn: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`\\b${fn}\\(`, "g");
  for (let m = open.exec(code); m; m = open.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
    }
    out.push(code.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

describe("readAt", () => {
  it("binds to the address it is given, not the current deployment", () => {
    const other = "0x" + "a".repeat(40);
    expect(readAt("orders", other).target).toBe(other);
  });

  it("falls back to the current deployment when nothing was recorded", () => {
    // Records written before `at` existed can only be orders from the
    // deployment of the day, so the fallback is the correct answer for them —
    // not merely a convenient one.
    const now = (DEPLOYED as { orders?: string }).orders;
    if (!now) return; // nothing deployed on this checkout
    expect(readAt("orders").target).toBe(now);
    expect(readAt("orders", undefined).target).toBe(now);
    expect(readAt("orders", "").target).toBe(now);
  });
});

describe("the order's own address", () => {
  it("is stamped when the order is created", () => {
    // If this stops being written, every subsequent order silently reverts to
    // resolving against whatever is current.
    expect(src("order/flow.ts")).toMatch(/at:\s*addressOf\("orders"\)/);
  });

  it("is passed by every customer-side call that takes it", () => {
    // The customer screen is the only place that opens a *stored* order, so
    // it is the only place this can be got wrong — and the only place where
    // getting it wrong shows someone else's delivery.
    const view = src("views/Ordering.tsx");
    for (const fn of [
      "orderOf",
      "pickupDeadline",
      "cancelOrder",
      "reopenTimedOut",
      "acceptBid",
      "watchBids",
    ]) {
      const calls = callsTo(view, fn);
      expect(calls.length, `${fn} is called in Ordering.tsx`).toBeGreaterThan(0);
      for (const args of calls) {
        // The record is variously `record`, `r` and `live.record` here, so
        // this checks the field is passed at all rather than what it is
        // spelled — the mistake being guarded against is omitting it.
        expect(args, `${fn}(…) must pass the order's address`).toMatch(
          /\.at\b/
        );
      }
    }
  });

  it("is what the order-scoped helpers actually read from", () => {
    // `read("orders")` ignores the argument; `readAt` is the one that honours
    // it. A helper that takes `at` and then calls `read` would typecheck,
    // accept the address, and quietly use the wrong contract.
    const orders = src("order/orders.ts");
    for (const fn of ["orderOf", "pickupDeadline"]) {
      const body = orders.slice(orders.indexOf(`export async function ${fn}`));
      const upToEnd = body.slice(0, body.indexOf("\n}"));
      expect(upToEnd, `${fn} must read from the order's own contract`).toContain(
        'readAt("orders", at)'
      );
    }
    const watch = src("order/bids.ts");
    const body = watch.slice(watch.indexOf("export async function watchBids"));
    expect(body.slice(0, body.indexOf("\n}"))).toContain('readAt("orders", at)');
  });

  it("is honoured by the writes too, not just the reads", () => {
    // Reading the wrong order is bad; cancelling it is worse.
    const orders = src("order/orders.ts");
    expect(orders).toMatch(
      /const orderContract = \(signer: Wallet, at\?: string\) =>\s*\n?\s*new Contract\(at \|\| addressOf\("orders"\)/
    );
    for (const fn of ["acceptBid", "cancelOrder", "reopenTimedOut"]) {
      const body = orders.slice(orders.indexOf(`export async function ${fn}`));
      const upToEnd = body.slice(0, body.indexOf("\n}"));
      expect(upToEnd, `${fn} must send to the order's own contract`).toMatch(
        /orderContract\(\s*burner,\s*at\s*\)/
      );
    }
  });
});
