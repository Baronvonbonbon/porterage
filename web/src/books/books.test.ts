// The books, tested where getting it wrong costs money.
//
// Two things here are not ordinary unit tests. `record` replacing rather than
// appending is what stops a replayed statement inflating a day's takings, and
// the CSV's number formatting is what stops a spreadsheet silently destroying
// an 18-digit amount. Both are the kind of bug that looks like nothing and
// ends up in a tax return.

import { describe, expect, it } from "vitest";
import { itemsCsv, ordersCsv } from "./csv";
import {
  dayOf,
  linesOf,
  mergeEntry,
  totalsOf,
  type LedgerEntry,
} from "./ledger";
import type { Bill } from "../order/bag";

const PAS = (n: string) => BigInt(Math.round(Number(n) * 1e18));

const bill: Bill = {
  goods: PAS("20"),
  items: [
    {
      item: { id: "a", name: "Reuben, half", price: PAS("7.5") },
      count: 2,
      wei: PAS("15"),
    },
    {
      item: { id: "b", name: 'Coffee, 12"', price: PAS("5") },
      count: 1,
      wei: PAS("5"),
    },
  ],
  tax: [
    { name: "State tax", wei: PAS("1.65"), bps: 825 },
    { name: "VAT", wei: PAS("0.4"), bps: 200 },
  ],
  taxTotal: PAS("2.05"),
  total: PAS("22.05"),
};

const entry = (over: Partial<LedgerEntry> = {}): LedgerEntry => ({
  kind: "sale",
  orderId: "7",
  at: Date.UTC(2026, 8, 21, 12, 0, 0),
  venue: "The Counter",
  ...linesOf(bill),
  ...over,
});

describe("freezing a bill", () => {
  it("copies names and unit prices, so a later menu edit cannot rewrite history", () => {
    const frozen = linesOf(bill);
    expect(frozen.lines[0]).toEqual({
      id: "a",
      name: "Reuben, half",
      count: 2,
      unitWei: PAS("7.5").toString(),
      wei: PAS("15").toString(),
    });
  });

  it("keeps each tax line with the rate that produced it", () => {
    // Without the bps the amount cannot be checked, and a vendor being audited
    // needs to show the rate, not just the money.
    const frozen = linesOf(bill);
    expect(frozen.tax).toEqual([
      { name: "State tax", bps: 825, wei: PAS("1.65").toString() },
      { name: "VAT", bps: 200, wei: PAS("0.4").toString() },
    ]);
    expect(frozen.taxTotal).toBe(PAS("2.05").toString());
  });

  it("records the total the venue is actually paid, goods plus tax", () => {
    expect(linesOf(bill).total).toBe(PAS("22.05").toString());
  });
});

describe("totals", () => {
  it("adds a day up without losing the tax split", () => {
    const t = totalsOf([entry(), entry({ orderId: "8" })]);
    expect(t.orders).toBe(2);
    expect(t.goods).toBe(PAS("40"));
    expect(t.tax).toBe(PAS("4.1"));
    expect(t.total).toBe(PAS("44.1"));
  });

  it("is zero for a day with nothing in it, rather than throwing", () => {
    expect(totalsOf([])).toEqual({
      orders: 0,
      goods: 0n,
      tax: 0n,
      total: 0n,
      net: 0n,
    });
  });
});

describe("orders.csv", () => {
  it("writes amounts as decimal PAS, not wei", () => {
    // 22050000000000000000 becomes 2.205E+19 in every spreadsheet on earth.
    const csv = ordersCsv([entry()]);
    expect(csv).toContain('"22.05"');
    expect(csv).not.toContain("22050000000000000000");
  });

  it("gives each named tax its own column", () => {
    const csv = ordersCsv([entry()]);
    expect(csv).toContain('"State tax (PAS)"');
    expect(csv).toContain('"VAT (PAS)"');
    expect(csv).toContain('"1.65"');
  });

  it("lines up tax columns across orders that charged different taxes", () => {
    // A vendor edits its tax lines mid-week. Both orders still have to sit
    // under the right headings, or a column sums two different taxes.
    const other = entry({
      orderId: "9",
      tax: [{ name: "VAT", bps: 200, wei: PAS("0.4").toString() }],
      taxTotal: PAS("0.4").toString(),
    });
    const rows = ordersCsv([entry(), other]).split("\r\n");
    const head = rows[0].split(",");
    const state = head.indexOf('"State tax (PAS)"');
    expect(state).toBeGreaterThan(-1);
    // The order that charged no state tax gets a zero in that column, not a
    // shifted row.
    expect(rows[2].split(",")[state]).toBe('"0"');
  });

  it("quotes a comma in an item or venue name without breaking the row", () => {
    const csv = ordersCsv([entry({ venue: "Sam's, on 3rd" })]);
    expect(csv).toContain('"Sam\'s, on 3rd"');
    expect(csv.split("\r\n")[1].split('","').length).toBeGreaterThan(3);
  });

  it("escapes a double quote by doubling it", () => {
    const csv = itemsCsv([entry()]);
    expect(csv).toContain('"Coffee, 12"""');
  });

  it("marks a row that disagrees with the chain, and leaves it blank when unchecked", () => {
    const agreed = ordersCsv([entry({ chainValue: PAS("22.05").toString() })]);
    expect(agreed).toContain('"yes"');
    const off = ordersCsv([entry({ chainValue: PAS("22").toString() })]);
    expect(off).toContain('"NO"');
    // Not checked is not the same as checked and fine.
    const unchecked = ordersCsv([entry()]);
    expect(unchecked).not.toContain('"yes"');
  });

  it("uses CRLF, which is the one thing Excel on Windows cares about", () => {
    expect(ordersCsv([entry()])).toContain("\r\n");
  });
});

describe("items.csv", () => {
  it("writes one row per line item, not per order", () => {
    const rows = itemsCsv([entry(), entry({ orderId: "8" })]).split("\r\n");
    expect(rows.length).toBe(1 + 4); // header + 2 items x 2 orders
  });

  it("carries the id, so it can be matched against stock", () => {
    expect(itemsCsv([entry()])).toContain('"a"');
  });

  it("does not repeat the order total, which would make any sum wrong", () => {
    // This is the whole reason items and orders are separate files.
    expect(itemsCsv([entry()])).not.toContain('"22.05"');
  });

  it("is just a header when there is nothing to export", () => {
    expect(itemsCsv([]).split("\r\n").length).toBe(1);
  });
});

describe("days", () => {
  it("groups by local calendar day, which is what a venue means by today", () => {
    const at = new Date(2026, 8, 21, 23, 30).getTime();
    expect(dayOf(at)).toBe("2026-09-21");
  });

  it("pads months and days so the strings sort", () => {
    expect(dayOf(new Date(2026, 0, 5).getTime())).toBe("2026-01-05");
  });
});

describe("a driver's earnings", () => {
  it("keeps fare, tip and fee apart, because only two of them are income", () => {
    const e: LedgerEntry = {
      kind: "earning",
      orderId: "7",
      at: Date.now(),
      fare: PAS("3").toString(),
      tip: PAS("1").toString(),
      fee: PAS("0.075").toString(),
      net: PAS("3.925").toString(),
    };
    const csv = ordersCsv([e]);
    expect(csv).toContain('"3.0"');
    expect(csv).toContain('"0.075"');
    expect(csv).toContain('"3.925"');
    expect(totalsOf([e]).net).toBe(PAS("3.925"));
  });
});

describe("writing a row twice", () => {
  // A venue's basket subscription replays statements it has already seen, and
  // a driver's job list re-reads the same delivered order on every poll. If
  // either appended, a day's takings would climb on its own.
  it("replaces rather than appends, so takings cannot inflate", () => {
    const first = entry({ at: 1000 });
    const again = entry({ at: 9999 });
    const out = mergeEntry([first], again);
    expect(out.length).toBe(1);
    expect(totalsOf(out).total).toBe(PAS("22.05"));
  });

  it("keeps the original time, so a replay after midnight stays on its own day", () => {
    const out = mergeEntry([entry({ at: 1000 })], entry({ at: 9999 }));
    expect(out[0].at).toBe(1000);
  });

  it("takes the newer content, because a correction should win", () => {
    const out = mergeEntry(
      [entry({ at: 1000 })],
      entry({ at: 9999, chainValue: "42" })
    );
    expect(out[0].chainValue).toBe("42");
  });

  it("keeps a sale and an earning for the same order apart", () => {
    // One device can be both -- a driver who also runs a venue -- and these
    // are two different rows in two different sets of books.
    const out = mergeEntry([entry()], entry({ kind: "earning" }));
    expect(out.length).toBe(2);
  });

  it("does not disturb other orders", () => {
    const out = mergeEntry([entry({ orderId: "1", at: 1 }), entry({ orderId: "2", at: 2 })], entry({ orderId: "1", at: 3 }));
    expect(out.length).toBe(2);
    expect(out.map((e) => e.orderId).sort()).toEqual(["1", "2"]);
  });

  it("keeps rows in time order", () => {
    const out = mergeEntry(
      [entry({ orderId: "2", at: 200 })],
      entry({ orderId: "1", at: 100 })
    );
    expect(out.map((e) => e.at)).toEqual([100, 200]);
  });
});
