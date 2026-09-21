// The books, as rows something else can read.
//
// CSV rather than anything cleverer, because the job is to stop being the
// accounting system. A venue already has one — a POS, a spreadsheet, an
// accountant with Xero — and the most useful thing Porterage can be is a clean
// source of rows for it. That is the actual lesson of how restaurants use
// DoorDash: almost none of them do their books in the merchant portal, they let
// orders land in their POS and the POS feeds the accounts.
//
// TWO SHAPES, because they answer different questions and one file cannot do
// both without lying:
//
//   orders.csv — one row per order. Reconciles against payouts and carries the
//                tax split. This is the file a tax return is built from.
//   items.csv  — one row per line item. Depletes inventory and says what sells.
//
// A single combined file repeats each order's total on every line, and anyone
// summing that column gets a number several times too big. Keeping them apart
// is not tidiness; it is the difference between a right answer and a wrong one.
//
// AMOUNTS ARE WRITTEN AS DECIMAL PAS, not wei. Wei is 18 digits and every
// spreadsheet in the world turns it into 1.23457E+18 on the way in, silently
// destroying it. The unit is in the column heading so nobody has to guess.

import { formatEther } from "ethers";
import type { LedgerEntry } from "./ledger";

/**
 * Quote a field for CSV. Everything is quoted rather than only what needs it:
 * a venue's item is called "Reuben, half" often enough, and a rule applied
 * sometimes is a rule that gets forgotten.
 */
const q = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;

const stamp = (at: number): string => new Date(at).toISOString();

const pas = (wei?: string): string => (wei ? formatEther(BigInt(wei)) : "0");

/**
 * Every tax name across these entries, in first-seen order. Tax lines are a
 * vendor's own free text and differ between orders when the menu changes, so
 * the header is built from what is actually there rather than assumed.
 */
function taxNames(entries: LedgerEntry[]): string[] {
  const seen: string[] = [];
  for (const e of entries)
    for (const t of e.tax ?? []) if (!seen.includes(t.name)) seen.push(t.name);
  return seen;
}

/** One row per order: what a tax return and a payout reconciliation need. */
export function ordersCsv(entries: LedgerEntry[]): string {
  const taxes = taxNames(entries);
  const head = [
    "date",
    "order",
    "venue",
    "goods (PAS)",
    ...taxes.map((n) => `${n} (PAS)`),
    "tax total (PAS)",
    "total (PAS)",
    "escrowed on chain (PAS)",
    "matches chain",
    "fare (PAS)",
    "tip (PAS)",
    "protocol fee (PAS)",
    "net (PAS)",
  ];
  const rows = entries.map((e) => {
    const byName = new Map((e.tax ?? []).map((t) => [t.name, t.wei]));
    // A blank rather than "yes" when the chain was never read: an accountant
    // should be able to tell "checked and agreed" from "not checked".
    const matches =
      e.chainValue === undefined || e.total === undefined
        ? ""
        : e.chainValue === e.total
        ? "yes"
        : "NO";
    return [
      stamp(e.at),
      e.orderId,
      e.venue ?? "",
      pas(e.goods),
      ...taxes.map((n) => pas(byName.get(n))),
      pas(e.taxTotal),
      pas(e.total),
      e.chainValue === undefined ? "" : pas(e.chainValue),
      matches,
      pas(e.fare),
      pas(e.tip),
      pas(e.fee),
      pas(e.net),
    ];
  });
  return table(head, rows);
}

/** One row per line item: what inventory and item-sales reporting need. */
export function itemsCsv(entries: LedgerEntry[]): string {
  const head = [
    "date",
    "order",
    "venue",
    "item id",
    "item",
    "count",
    "unit price (PAS)",
    "amount (PAS)",
  ];
  const rows: string[][] = [];
  for (const e of entries) {
    for (const l of e.lines ?? []) {
      rows.push([
        stamp(e.at),
        e.orderId,
        e.venue ?? "",
        l.id,
        l.name,
        String(l.count),
        pas(l.unitWei),
        pas(l.wei),
      ]);
    }
  }
  return table(head, rows);
}

/**
 * CRLF line endings, because Excel on Windows is the single most likely thing
 * to open these and it is the one that cares. Everything else copes.
 */
function table(head: string[], rows: string[][]): string {
  return [head.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join(
    "\r\n"
  );
}

/**
 * Hand a CSV to the person.
 *
 * `<a download>` and blob: URLs are both blocked inside the Polkadot app's
 * WebView, so a download link would silently do nothing — the worst possible
 * failure for the one button whose entire job is to get data OUT. The
 * clipboard works everywhere and pastes straight into a spreadsheet, so that
 * is the path that is offered first, with the text shown underneath for a
 * device where even that is refused.
 */
export async function offer(text: string): Promise<"copied" | "shown"> {
  try {
    await navigator.clipboard.writeText(text);
    return "copied";
  } catch {
    return "shown";
  }
}
