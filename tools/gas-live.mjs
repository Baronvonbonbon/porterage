// Turn a fleet run into a gas table measured on the chain it ran against.
//
//   node tools/gas-live.mjs [fixtures/fleet-run.json]
//
// `gas-snapshot.json` is written by the Hardhat test suite, which runs on an
// EVM. The contracts are deployed to Passet Hub, which runs PolkaVM through
// pallet-revive, and the two do not charge the same gas for the same work —
// not by a little. Measured across a hundred live orders:
//
//   orders.createOrder            196,701 on Hardhat      21,010 live
//   settlement.confirmDropoffZK   213,317 on Hardhat      18,209 live
//   ratings.rate                  107,665 on Hardhat       8,479 live
//
// `tools/costs.mjs` was multiplying the Hardhat figures by Passet Hub's gas
// price, which overstated the cost of every action by roughly ten times. The
// irony is that the tool exists because "a cost written into prose is wrong
// within a month and nobody notices" — and it was wrong itself, for the same
// reason one layer down: a number measured somewhere other than where it is
// spent.
//
// This writes `gas-live.json`, which costs.mjs prefers when it is present.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2] ?? join(root, "fixtures", "fleet-run.json");
const run = JSON.parse(readFileSync(src, "utf8"));

/** fleet.ts's action names → the names gas-snapshot.json uses. */
const AS = {
  createOrder: "orders.createOrder",
  commitBid: "orders.commitBid",
  acceptSealedBid: "orders.acceptSealedBid",
  confirmPickup: "settlement.confirmPickup",
  confirmDropoffZK: "settlement.confirmDropoffZK",
  rate: "ratings.rate",
  registerDriver: "drivers.register",
  registerVenue: "venues.registerVenue",
  openDispute: "disputes.openDispute",
  resolveDispute: "disputes.resolve",
  insertShieldNote: "vault.insertShieldNote",
  cancelOpen: "orders.cancelOpen",
  cancelAssigned: "orders.cancelAssigned",
  abandonOrder: "orders.abandonOrder",
  reopenTimedOut: "orders.reopenTimedOut",
};

const out = {};
let measured = 0;
for (const row of run.costs ?? []) {
  const name = AS[row.action];
  if (!name || !row.txs) continue;
  // The mean over every time that action ran. Gas varies a little with
  // calldata and storage state; a hundred orders is enough that the average
  // is the number to quote.
  out[name] = Math.round(Number(row.gas) / row.txs);
  measured++;
}

if (!measured) {
  console.error(`no per-action gas in ${src} — was it written by a newer fleet.ts?`);
  process.exit(1);
}

const dest = join(root, "gas-live.json");
writeFileSync(
  dest,
  JSON.stringify(
    {
      "//": "Measured on chain by tools/fleet.ts. Preferred over gas-snapshot.json, which is Hardhat's EVM.",
      measuredAt: run.at,
      network: "Passet Hub (Paseo Asset Hub)",
      orders: run.orders,
      gas: out,
    },
    null,
    2
  ) + "\n"
);

console.log(`${measured} actions measured over ${run.orders} orders → gas-live.json`);
const snapshot = JSON.parse(readFileSync(join(root, "gas-snapshot.json"), "utf8"));
for (const [name, live] of Object.entries(out)) {
  const hardhat = snapshot[name];
  if (!hardhat) continue;
  console.log(
    `   ${name.padEnd(32)} ${String(hardhat).padStart(8)} hardhat  ` +
      `${String(live).padStart(8)} live  ${(hardhat / live).toFixed(1)}x`
  );
}
