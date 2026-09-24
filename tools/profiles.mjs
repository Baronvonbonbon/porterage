// Venue storefronts and driver portraits, drawn rather than downloaded.
//
//   node tools/profiles.mjs [count]
//
// The fleet run needs a face for every venue and every driver. Stock
// photography would look better in a screenshot and would be the wrong choice:
// it puts someone else's licensed work inside a published product, makes the
// test depend on a remote host staying up, and gives a different picture every
// run. These are derived from the name, so they are the same every time, they
// are ours, and they need no network.
//
// Everything is one SVG each, in the app's own tokens, so they sit in a
// Porterage screen without looking borrowed from a different product.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(fileURLToPath(new URL("../fixtures/profiles", import.meta.url)));

/** A small stable hash: the same name must always give the same picture. */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
// `>>>`, not `>>`: a signed shift on a 32-bit hash goes negative, and a
// negative index silently yields undefined — which reaches the SVG as
// fill="undefined" and paints the card black.
const pick = (arr, seed) => arr[(seed >>> 0) % arr.length];

// Warm neighbours of the app's rust accent, chosen to sit beside it rather
// than fight it. Every one of them holds its own against both themes.
const INK = [
  "#a4452c", "#8a5a00", "#2f6b3a", "#41548a", "#7a3b6a",
  "#9c6b1f", "#3f6f72", "#8c3b3b",
];
const GROUND = ["#f4ece2", "#efe9df", "#f6efe6", "#eee7dd"];

/** SVG is XML: a raw & or < in a name makes the whole file unparseable, and
 *  the browser shows a broken image rather than an error. "Thistle & Ash". */
const xml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const initials = (name) =>
  name
    .replace(/[^A-Za-z ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

/** A storefront: awning, window, door, and the name over the top. */
export function venueSvg(name) {
  const h = hash(name);
  const ink = pick(INK, h);
  const ground = pick(GROUND, h >> 3);
  const stripes = 6 + (h % 4);
  const awning = Array.from({ length: stripes }, (_, i) => {
    const w = 200 / stripes;
    return i % 2
      ? `<rect x="${20 + i * w}" y="54" width="${w}" height="26" fill="${ink}" opacity="0.85"/>`
      : "";
  }).join("");
  // A scalloped hem reads as an awning at a glance where a straight edge
  // reads as a shelf.
  const hem = Array.from({ length: stripes }, (_, i) => {
    const w = 200 / stripes;
    return `<path d="M${20 + i * w} 80a${w / 2} ${w / 2.6} 0 0 0 ${w} 0" fill="${ink}" opacity="0.85"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 160" width="240" height="160" role="img" aria-label="${xml(name)}">
  <rect width="240" height="160" fill="${ground}"/>
  <rect x="20" y="80" width="200" height="66" fill="#fff" opacity="0.55"/>
  <rect x="34" y="96" width="74" height="50" rx="3" fill="${ink}" opacity="0.14"/>
  <rect x="132" y="96" width="74" height="50" rx="3" fill="${ink}" opacity="0.14"/>
  <rect x="104" y="104" width="32" height="42" rx="2" fill="${ink}" opacity="0.3"/>
  <rect x="20" y="54" width="200" height="26" fill="${ink}" opacity="0.35"/>
  ${awning}${hem}
  <text x="120" y="38" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif"
        font-size="20" font-weight="600" fill="${ink}">${initials(name)}</text>
  <text x="120" y="154" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif"
        font-size="9" fill="${ink}" opacity="0.75">${xml(name)}</text>
</svg>`;
}

/** A driver: the carrying mark from the app, on a disc of their own colour. */
export function driverSvg(name) {
  const h = hash(name);
  const ink = pick(INK, h >> 1);
  const ground = pick(GROUND, h >> 5);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="${xml(name)}">
  <circle cx="64" cy="64" r="64" fill="${ground}"/>
  <circle cx="64" cy="64" r="50" fill="none" stroke="${ink}" stroke-width="2" opacity="0.35"/>
  <g transform="translate(32 30) scale(2)" fill="none" stroke="${ink}" stroke-width="2.5"
     stroke-linecap="round" stroke-linejoin="round">
    <g transform="rotate(-14 15 7)"><rect x="8.4" y="3" width="13.2" height="7.6" rx="2"/></g>
    <path d="M15.2 12.6 14.4 19"/><path d="M14.4 19 9 28.6"/><path d="M14.4 19 20.8 28.6"/>
  </g>
  <text x="64" y="116" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif"
        font-size="12" font-weight="600" fill="${ink}">${initials(name)}</text>
</svg>`;
}

// ── the cast ────────────────────────────────────────────────────────────────
// Invented names. Nothing here should collide with a real business, because a
// test fixture that names a real shop is a test fixture that libels one.
export const VENUE_NAMES = [
  "Thistle & Ash", "The Copper Ladle", "Noon Bakehouse", "Saltfeather",
  "Greenmarket Deli", "Ember & Rye", "The Blue Gate", "Marrow Lane Kitchen",
  "Pellet & Pine", "Quayside Grocers",
];
export const DRIVER_NAMES = [
  "Wren Halloway", "Ida Marsh", "Tobias Crane", "Nell Ashford", "Otis Vane",
  "Juno Blackwood", "Pim Calloway", "Sable Reyes", "Hollis Frey", "Etta Lark",
];

function main() {
  mkdirSync(OUT, { recursive: true });
  const made = [];
  for (const n of VENUE_NAMES) {
    const f = `venue-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.svg`;
    writeFileSync(join(OUT, f), venueSvg(n));
    made.push([n, f]);
  }
  for (const n of DRIVER_NAMES) {
    const f = `driver-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.svg`;
    writeFileSync(join(OUT, f), driverSvg(n));
    made.push([n, f]);
  }
  // A contact sheet, so they can be looked at rather than assumed.
  writeFileSync(
    join(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Porterage fixtures</title>
<style>body{background:#faf8f5;font:14px system-ui;margin:0;padding:24px}
h2{font-size:15px;color:#6b6560;margin:24px 0 10px}
.g{display:flex;flex-wrap:wrap;gap:14px}figure{margin:0}img{display:block;border-radius:8px}</style>
<h2>Venues</h2><div class="g">${VENUE_NAMES.map(
      (n) =>
        `<figure><img src="venue-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.svg"></figure>`
    ).join("")}</div>
<h2>Drivers</h2><div class="g">${DRIVER_NAMES.map(
      (n) =>
        `<figure><img src="driver-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.svg"></figure>`
    ).join("")}</div>`
  );
  console.log(`wrote ${made.length} profiles + a contact sheet to fixtures/profiles/`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
