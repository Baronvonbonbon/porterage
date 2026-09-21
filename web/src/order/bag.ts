// The bag and what it adds up to (docs/IMPROVEMENTS.md §5).
//
// Separate from `menu.ts` because a bag is the customer's, not the venue's: the
// menu is a public document the vendor publishes, and this is arithmetic done
// on the phone holding it. Nothing here goes anywhere — the venue is told what
// to make in `kitchen.ts`, sealed, and the chain is told a single number.
//
// THE ONE RULE THIS MODULE EXISTS TO KEEP: the number the customer is shown and
// the number the customer is charged are computed once, here, and are the same
// number. Every screen that shows a total reads `billFor`; nothing adds tax on
// its own or rounds on the way past. A bill that disagrees with the charge by a
// planck is a bill nobody can argue with, and "it's only rounding" is how that
// starts.
//
// Rounding: tax is `subtotal × bps / 10000` in integer wei, truncated — the
// fraction of a planck goes to the customer, not the vendor. It is worth less
// than 10^-18 PAS and the direction should still be written down.

import type { Menu, MenuItem, TaxLine } from "./menu";

export interface BillLine {
  name: string;
  wei: bigint;
  /** Set on tax lines, so a screen can show "8.25%" beside the amount. */
  bps?: number;
}

export interface Bill {
  /** What was picked, priced. */
  goods: bigint;
  /** One line per item, for the bag list. */
  items: { item: MenuItem; count: number; wei: bigint }[];
  /** The vendor's named charges, each already worked out in wei. */
  tax: BillLine[];
  /** All the tax lines together. */
  taxTotal: bigint;
  /** What the customer pays the venue: goods + tax. This is `orderValue`. */
  total: bigint;
}

/** What one bag comes to. The only place a total is worked out. */
export function billFor(menu: Menu, picked: Map<string, number>): Bill {
  const items = menu.items
    .map((item) => ({ item, count: picked.get(item.id) ?? 0 }))
    .filter((row) => row.count > 0)
    .map((row) => ({ ...row, wei: row.item.price * BigInt(row.count) }));

  const goods = items.reduce((sum, row) => sum + row.wei, 0n);
  const tax = (menu.tax ?? []).map((line: TaxLine) => ({
    name: line.name,
    bps: line.bps,
    wei: (goods * BigInt(line.bps)) / 10_000n,
  }));
  const taxTotal = tax.reduce((sum, line) => sum + line.wei, 0n);

  return { goods, items, tax, taxTotal, total: goods + taxTotal };
}

/** How many things are in the bag, for the badge on the button. */
export const bagCount = (picked: Map<string, number>): number =>
  [...picked.values()].reduce((n, c) => n + c, 0);

// ── price tier ──────────────────────────────────────────────────────────────

/**
 * The $ / $$ / $$$ on a tile. Taken from the MEDIAN item price, not the mean
 * or the cheapest: one bottle of wine on a café's menu shouldn't make it
 * expensive, and one bag of crisps shouldn't make a restaurant cheap.
 *
 * The thresholds are in PAS and will be wrong for a real currency; they are
 * here rather than in a config because a tier is a comparison between venues
 * in one list, and the only thing that matters is that every tile uses the
 * same ruler. Moving to a real currency changes these two numbers.
 */
const CHEAP = 2n * 10n ** 18n;
const MIDDLING = 10n * 10n ** 18n;

export function priceTier(menu: Menu): 1 | 2 | 3 | null {
  const prices = menu.items
    .map((i) => i.price)
    .filter((p) => p > 0n)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!prices.length) return null;
  const median = prices[Math.floor(prices.length / 2)];
  return median < CHEAP ? 1 : median < MIDDLING ? 2 : 3;
}

/**
 * The tier as glyphs, in whatever symbol the person set (settings.ts). The
 * symbol is decoration and says nothing about what is being charged — the
 * amounts on every screen are PAS, and a `$` beside a PAS figure would be a
 * lie. It is here so a tile reads the way its reader expects a tile to read.
 */
export const tierGlyphs = (tier: 1 | 2 | 3 | null, symbol: string): string =>
  tier === null ? "" : symbol.repeat(tier);
