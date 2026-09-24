// Take the fleet harness's venues back out of the shop window.
//
//   node tools/retire-fleet-venues.mjs            # say what it would do
//   node tools/retire-fleet-venues.mjs --do-it    # do it
//
// The fleet registers a venue per lane so that lanes cannot race each other,
// and it registers them ON THE LIVE REGISTRY, which is the same registry a
// customer browses. Five seeds' worth of runs left twenty of them, ids 16–35,
// each with a `metadataURI` pointing at a file in this repo — so they render
// as "Venue #33" with no picture and no menu, and they buried the real venues
// under twenty entries nobody can order from.
//
// `setActive(id, false)` is operator-gated, and the fleet's operators are
// derived from its seed, so the same derivation that made them retires them.
// Nothing is deleted: the records and their pickup counts stay, they simply
// stop saying they are open.
//
// Venues are found by asking the contract which ones each operator owns rather
// than by guessing ids, so a seed that registered nothing costs one call and a
// seed that registered three is fully covered.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  JsonRpcProvider,
  Wallet,
  keccak256,
  toUtf8Bytes,
} from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const book = JSON.parse(readFileSync(join(here, "..", "src", "deployed.json"), "utf8"));
const ABI = JSON.parse(
  readFileSync(join(here, "..", "src", "abi", "PorterVenues.json"), "utf8")
);

/** Every seed a fleet run has used against the live chain. */
const SEEDS = [
  "porterage-fleet-1",
  "fleet-100-a",
  "fleet-100-b",
  "rehearsal-1",
  "rehearsal-2",
  "rehearsal-3",
  "rehearsal-4",
  "rehearsal-5",
  "rehearsal-6",
  "rehearsal-7",
  "rehearsal-8",
];
/** Lanes per run never went past this. */
const LANES = 10;

const DO_IT = process.argv.includes("--do-it");
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const eth = new JsonRpcProvider(RPC);

/** fleet.ts: `derive("venueop", n)`. Same seed, same key. */
const venueOp = (seed, n) =>
  new Wallet(keccak256(toUtf8Bytes(`${seed}:venueop:${n}`)), eth);

const venues = new Contract(book.venues, ABI.abi ?? ABI, eth);

const found = [];
for (const seed of SEEDS) {
  for (let n = 0; n < LANES; n++) {
    const op = venueOp(seed, n);
    let count = 0;
    try {
      count = Number(await venues.venueCountOf(op.address));
    } catch {
      continue; // an operator the registry has never heard of
    }
    for (let i = 0; i < count; i++) {
      const id = await venues.venuesByOperator(op.address, i);
      const v = await venues.venues(id);
      if (!v.active) continue;
      found.push({ id, op, seed, n, uri: v.metadataURI });
    }
  }
}

if (!found.length) {
  console.log("No active fleet venues. Nothing to retire.");
  eth.destroy();
  process.exit(0);
}

console.log(`${found.length} active fleet venue(s):\n`);
for (const f of found)
  console.log(
    `   #${String(f.id).padStart(3)}  ${f.seed} lane ${f.n}  ${f.uri || "(no metadata)"}`
  );

if (!DO_IT) {
  console.log(`\nThis was a dry run. Pass --do-it to retire them.`);
  eth.destroy();
  process.exit(0);
}

// The operators need gas, and they were swept empty at the end of their run.
const deployKey = readFileSync(
  join(homedir(), ".config", "porterage", "deploy-key"),
  "utf8"
).trim();
const deployer = new Wallet(
  deployKey.startsWith("0x") ? deployKey : `0x${deployKey}`,
  eth
);

console.log(`\nRetiring…`);
const GAS_EACH = 10n ** 17n; // 0.1 PAS, an order of magnitude over the ~26k gas
let done = 0;
for (const f of found) {
  try {
    if ((await eth.getBalance(f.op.address)) < GAS_EACH / 2n) {
      const top = await deployer.sendTransaction({
        to: f.op.address,
        value: GAS_EACH,
      });
      await top.wait();
    }
    const tx = await new Contract(book.venues, ABI.abi ?? ABI, f.op).setActive(
      f.id,
      false
    );
    await tx.wait();
    console.log(`   #${f.id} closed`);
    done++;
  } catch (e) {
    console.log(`   #${f.id} FAILED: ${e.shortMessage ?? e.message}`);
  }
}
console.log(`\n${done}/${found.length} retired.`);
eth.destroy();
