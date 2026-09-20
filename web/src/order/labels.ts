// What kind of place a venue is (docs/IMPROVEMENTS.md §3).
//
// A FIXED vocabulary, not free text. Free tags read better and filter worse:
// "coffee", "Coffee" and "espresso bar" are three different filters, and a
// customer looking for somewhere to get a coffee finds one of them. A short
// closed list means everyone who picks the same thing picks the same word.
//
// It lives in the menu document on Bulletin, so changing this list costs
// nothing — no contract, no redeploy, and a venue that republishes picks up the
// new words. The price is that filtering by label needs every venue's menu
// fetched before the list can be drawn, which is why menus are cached by their
// content hash (order/menu.ts).
//
// Keep it short. A vocabulary nobody can hold in their head is free text with
// extra steps.

export const LABELS = [
  "coffee",
  "bakery",
  "hot-food",
  "groceries",
  "pharmacy",
  "alcohol",
  "hardware",
  "other",
] as const;

export type Label = (typeof LABELS)[number];

/** How many a venue may claim. Two is a place; five is a directory listing. */
export const MAX_LABELS = 2;

const WORDS: Record<Label, string> = {
  coffee: "Coffee",
  bakery: "Bakery",
  "hot-food": "Hot food",
  groceries: "Groceries",
  pharmacy: "Pharmacy",
  alcohol: "Alcohol",
  hardware: "Hardware",
  other: "Other",
};

export const labelWord = (l: string): string => WORDS[l as Label] ?? l;

export const isLabel = (l: string): l is Label =>
  (LABELS as readonly string[]).includes(l);

/** Keep only words this version knows, and only as many as are allowed. */
export const cleanLabels = (raw: unknown): Label[] =>
  Array.isArray(raw)
    ? [
        ...new Set(
          raw.filter((l): l is Label => typeof l === "string" && isLabel(l))
        ),
      ].slice(0, MAX_LABELS)
    : [];

/** Does this venue match what the customer asked for? No filter matches everything. */
export const matchesLabels = (venue: Label[], wanted: Label[]): boolean =>
  wanted.length === 0 || venue.some((l) => wanted.includes(l));
