// The demo venues, as menu documents the app can carry itself.
//
//   node tools/demo-set.mjs        # writes web/src/order/demo.json
//
// WHY THESE ARE BUNDLED RATHER THAN PUBLISHED. A real venue's menu lives on
// Bulletin, and a customer fetches it with `hostGet`. Nothing outside the
// Polkadot app can write there: `hostPut` needs a `BulletinAllowance` and a
// `PreimageSubmit` permission that land on a slot account only the host can
// sign with, so it costs a prompt on a phone, once per venue. And Bulletin
// storage lasts about two weeks — a demo set published that way would silently
// lose its menus every fortnight and look exactly like the bug it was built to
// fix.
//
// So the demo menus travel with the app. They are ORDINARY MENU DOCUMENTS in
// the same wire format a venue publishes, decoded by the same `decodeMenu`, so
// there is no second parser to drift. Only where the bytes come from differs.
//
// HOW TO REMOVE ALL OF THIS, because it was the first question asked of it:
//
//   1. `node web/tools/demo-venues.mjs --retire` closes the venues on chain.
//      Their operator keys are derived from the seed below, so this works as
//      long as this file exists.
//   2. Delete `web/src/order/demo.json`, this file, and the `demo:` branch in
//      `order/menu.ts` and `order/shopfront.ts`.
//
// Step 1 alone is enough to take them out of the app; step 2 removes the code.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { venueSvg } from "./profiles.mjs";

const PAS = 10n ** 18n;
/** Prices read as PAS in the menu and are stored in wei, as a venue publishes them. */
const pas = (n) => String(BigInt(Math.round(n * 1000)) * (PAS / 1000n));

/**
 * Five places with enough between them to tell the screens apart: a bakery
 * with no tax, a grocer with several sections, somewhere with a long menu and
 * somewhere with three items.
 */
const VENUES = [
  {
    slug: "thistle-and-ash",
    name: "Thistle & Ash",
    labels: ["hot-food"],
    tax: [{ name: "State tax", bps: 875 }],
    items: [
      ["soup", "Soup of the day", 0.8, "Small plates", "Whatever the pot has"],
      ["bread", "Sourdough round", 1.2, "Small plates"],
      ["barley", "Barley salad", 1.5, "Small plates"],
      ["pie", "Mutton pie", 3.2, "Mains"],
      ["roast", "Sunday roast", 4.5, "Mains", "From noon, while it lasts"],
      ["crumble", "Apple crumble", 1.6, "Puddings"],
    ],
  },
  {
    slug: "the-copper-ladle",
    name: "The Copper Ladle",
    labels: ["hot-food"],
    tax: [{ name: "State tax", bps: 700 }],
    items: [
      ["stew", "Copper stew", 2.4, "Mains", "Beef, barley, a long afternoon"],
      ["dumplings", "Dumplings, six", 1.8, "Mains"],
      ["pickles", "House pickles", 0.6, "Sides"],
      ["broth", "Clear broth", 1.1, "Sides"],
    ],
  },
  {
    slug: "noon-bakehouse",
    name: "Noon Bakehouse",
    labels: ["bakery", "coffee"],
    tax: [],
    items: [
      ["bun", "Morning bun", 0.5, "Counter"],
      ["rye", "Rye loaf", 1.1, "Counter"],
      ["sourdough", "Sourdough, large", 1.4, "Counter"],
      ["coffee", "Coffee", 0.7, "Drinks"],
      ["tea", "Pot of tea", 0.6, "Drinks"],
    ],
  },
  {
    slug: "saltfeather",
    name: "Saltfeather",
    labels: ["hot-food"],
    tax: [
      { name: "State tax", bps: 1000 },
      { name: "Service", bps: 500 },
    ],
    items: [
      ["trout", "Smoked trout", 3.1, "Plates"],
      ["sea-salad", "Sea salad", 1.4, "Plates"],
      ["tart", "Lemon tart", 1.2, "Puddings"],
    ],
  },
  {
    slug: "greenmarket-deli",
    name: "Greenmarket Deli",
    labels: ["groceries"],
    tax: [{ name: "State tax", bps: 875 }],
    items: [
      ["board", "Deli board", 2.9, "Ready to eat"],
      ["olives", "Olives, tub", 0.7, "Ready to eat"],
      ["flatbread", "Flatbread", 0.6, "Bakery"],
      ["milk", "Milk, 1L", 0.4, "Dairy"],
      ["butter", "Butter, 250g", 0.9, "Dairy"],
      ["eggs", "Eggs, six", 0.8, "Dairy"],
      ["apples", "Apples, bag", 1.1, "Fruit and veg"],
      ["potatoes", "Potatoes, 2kg", 0.9, "Fruit and veg"],
    ],
  },
];

/** The picture, inline, so a demo venue needs no fetch and cannot 404. */
const dataUri = (svg) =>
  `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;

const out = {};
for (const v of VENUES) {
  // v:2 is what the app publishes today; `decodeMenu` reads the same shape
  // whether it came from Bulletin or from here.
  out[v.slug] = {
    v: 2,
    name: v.name,
    items: v.items.map(([id, n, price, s, d]) => ({
      id,
      n,
      p: pas(price),
      ...(s ? { s } : {}),
      ...(d ? { d } : {}),
    })),
    ...(v.labels.length ? { l: v.labels } : {}),
    ...(v.tax.length ? { t: v.tax } : {}),
    ph: dataUri(venueSvg(v.name)),
  };
}

const dest = join(
  fileURLToPath(new URL("../web/src/order", import.meta.url)),
  "demo.json"
);
writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);

const bytes = JSON.stringify(out).length;
console.log(
  `${VENUES.length} demo menus → web/src/order/demo.json (${(bytes / 1024) | 0} kB)`
);
for (const v of VENUES)
  console.log(`   ${v.slug.padEnd(20)} ${v.items.length} items, ${v.tax.length} tax line(s)`);
