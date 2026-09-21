import { describe, expect, it } from "vitest";
import { bagCount, billFor, priceTier, tierGlyphs } from "./bag";
import {
  cleanTax,
  decodeMenu,
  encodeMenu,
  sectionsOf,
  type Menu,
} from "./menu";

const pas = (n: number) => BigInt(Math.round(n * 1000)) * 10n ** 15n;

const cafe: Menu = {
  name: "Blue Cup",
  items: [
    { id: "a", name: "Flat white", price: pas(1.5), section: "Drinks" },
    { id: "b", name: "Croissant", price: pas(2.5), section: "Food" },
    { id: "c", name: "Cold brew", price: pas(2), section: "Drinks" },
  ],
  tax: [
    { name: "State tax", bps: 825 },
    { name: "Service", bps: 1000 },
  ],
};

describe("the bag", () => {
  it("charge exactly what the bill shows, tax included", () => {
    // The whole point of the module: one number, computed once.
    const bill = billFor(cafe, new Map([["a", 2]]));
    expect(bill.goods).toBe(pas(3));
    expect(bill.tax.map((t) => t.name)).toEqual(["State tax", "Service"]);
    expect(bill.taxTotal).toBe(bill.tax[0].wei + bill.tax[1].wei);
    expect(bill.total).toBe(bill.goods + bill.taxTotal);
  });

  it("work tax out on the goods, not on the running total", () => {
    // Two 10% lines on 100 must be 120, never 121 — tax on tax is a bug
    // people notice and never forgive.
    const menu: Menu = {
      name: "x",
      items: [{ id: "a", name: "thing", price: pas(100) }],
      tax: [
        { name: "One", bps: 1000 },
        { name: "Two", bps: 1000 },
      ],
    };
    const bill = billFor(menu, new Map([["a", 1]]));
    expect(bill.total).toBe(pas(120));
  });

  it("round a fraction of a planck towards the customer", () => {
    // 1 wei at 825 bps is 0.0825 wei. Truncation gives the vendor nothing
    // rather than giving it a wei it wasn't owed.
    const menu: Menu = {
      name: "x",
      items: [{ id: "a", name: "dust", price: 1n }],
      tax: [{ name: "State tax", bps: 825 }],
    };
    expect(billFor(menu, new Map([["a", 1]])).total).toBe(1n);
  });

  it("come to nothing when the bag is empty, tax lines or not", () => {
    const bill = billFor(cafe, new Map());
    expect(bill.goods).toBe(0n);
    expect(bill.taxTotal).toBe(0n);
    expect(bill.total).toBe(0n);
    expect(bill.items).toEqual([]);
  });

  it("ignore an item id the menu doesn't have", () => {
    // A stale bag against a republished menu: the item is gone, not free.
    const bill = billFor(cafe, new Map([["gone", 3]]));
    expect(bill.total).toBe(0n);
  });

  it("count what's in the bag for the badge", () => {
    expect(bagCount(new Map())).toBe(0);
    expect(
      bagCount(
        new Map([
          ["a", 2],
          ["b", 1],
        ])
      )
    ).toBe(3);
  });
});

describe("tax lines a stranger wrote", () => {
  // A menu is a public document. Whatever comes back is checked before a
  // customer is asked to pay it.
  it("drop a line that is unnamed, negative, zero or absurd", () => {
    expect(
      cleanTax([
        { name: "", bps: 100 },
        { name: "Negative", bps: -500 },
        { name: "Zero", bps: 0 },
        { name: "Absurd", bps: 500_000 },
        { name: "Fine", bps: 825 },
      ])
    ).toEqual([{ name: "Fine", bps: 825 }]);
  });

  it("drop rather than clamp", () => {
    // Showing 50% where the document said 5000% is a worse lie than showing
    // nothing: the customer can't see that anything was changed.
    expect(cleanTax([{ name: "Huge", bps: 90_000 }])).toEqual([]);
  });

  it("keep at most four lines", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `Line ${i}`,
      bps: 100,
    }));
    expect(cleanTax(many).length).toBe(4);
  });

  it("refuse a fractional rate", () => {
    expect(cleanTax([{ name: "Odd", bps: 12.5 }])).toEqual([]);
  });
});

describe("menu sections", () => {
  it("keep the vendor's own order, by first appearance", () => {
    expect(sectionsOf(cafe).map((s) => s.name)).toEqual(["Drinks", "Food"]);
    expect(sectionsOf(cafe)[0].items.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("put items with no section last, never first", () => {
    const menu: Menu = {
      name: "x",
      items: [
        { id: "a", name: "loose", price: pas(1) },
        { id: "b", name: "drink", price: pas(1), section: "Drinks" },
      ],
    };
    expect(sectionsOf(menu).map((s) => s.name)).toEqual(["Drinks", ""]);
  });

  it("draw a menu that never used sections exactly as before", () => {
    const menu: Menu = {
      name: "x",
      items: [
        { id: "a", name: "one", price: pas(1) },
        { id: "b", name: "two", price: pas(1) },
      ],
    };
    const only = sectionsOf(menu);
    expect(only.length).toBe(1);
    expect(only[0].name).toBe("");
    expect(only[0].items.length).toBe(2);
  });
});

describe("the menu document", () => {
  it("carry sections, notes, a photo and tax through a round trip", () => {
    const full: Menu = {
      ...cafe,
      photo: "0xabc",
      items: [{ ...cafe.items[0], note: "double shot" }],
    };
    const back = decodeMenu(encodeMenu(full));
    expect(back.items[0].section).toBe("Drinks");
    expect(back.items[0].note).toBe("double shot");
    expect(back.photo).toBe("0xabc");
    expect(back.tax).toEqual(cafe.tax);
  });

  it("still read a v1 menu, which has none of them", () => {
    const v1 = new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        name: "Old",
        items: [{ id: "a", n: "Tea", p: pas(1).toString() }],
      })
    );
    const back = decodeMenu(v1);
    expect(back.name).toBe("Old");
    expect(back.items[0].price).toBe(pas(1));
    expect(back.tax).toBeUndefined();
  });
});

describe("the price tier", () => {
  it("read the median, so one outlier doesn't move it", () => {
    // A café with one bottle of wine is still a café.
    const menu: Menu = {
      name: "x",
      items: [
        { id: "a", name: "tea", price: pas(1) },
        { id: "b", name: "cake", price: pas(1.5) },
        { id: "c", name: "wine", price: pas(90) },
      ],
    };
    expect(priceTier(menu)).toBe(1);
  });

  it("say nothing at all about an empty menu", () => {
    expect(priceTier({ name: "x", items: [] })).toBe(null);
    expect(tierGlyphs(null, "$")).toBe("");
  });

  it("use whichever symbol was chosen, and only as decoration", () => {
    expect(tierGlyphs(3, "$")).toBe("$$$");
    expect(tierGlyphs(2, "£")).toBe("££");
  });
});
