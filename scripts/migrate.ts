// Carry reputation across a contract upgrade.
//
//   npx hardhat run scripts/migrate.ts --network polkadotTestnet
//
// The copy functions on PorterDrivers, PorterVenues and PorterRatings are
// paginated and onlyOwner, which means somebody has to enumerate the records
// and push them in batches. Nobody did, so the functions existed and the
// migration did not.
//
// Enumeration is the hard part, and the obvious answer is wrong.
//
// `DriverRegistered` / `VenueRegistered` look like the list, and on a local
// node they are. On Passet Hub they are not: venue #6 is live on chain, with a
// `PickupRecorded` event of its own, and its `VenueRegistered` event is simply
// absent from the RPC's log index. One registration, silently missing, with
// nothing anywhere reporting it — which is the exact failure this script is
// supposed to prevent.
//
// So events are used only where nothing better exists:
//
//   Venues  — enumerated by id, 1..nextVenueId-1, straight from contract
//             storage. Authoritative. No logs involved.
//   Drivers — keyed by address, so the chain offers no enumeration at all.
//             The candidate set is every address mentioned in ANY event the
//             contract emitted (registration, session keys, reputation,
//             slashing) plus any in `EXTRA_DRIVERS`, and each candidate is
//             then confirmed against `drivers(addr).registered`, which is
//             authoritative. A wide net, narrowed by the contract itself.
//
// After importing, this READS BACK every record. An import that silently
// skipped half its batch looks exactly like one that worked, and the failure
// surfaces weeks later as a driver whose rating vanished.
//
// Set OLD_DRIVERS / OLD_VENUES / OLD_RATINGS to the predecessors. Anything left
// unset is skipped, so one contract can be migrated at a time.

import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

// A starting page size, not a limit — `inPages` splits when the chain says no.
const BATCH = 25;

const suffix = ["polkadotTestnet", "pine"].includes(network.name)
  ? ""
  : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);

export type Addresses = Record<string, string>;

async function main() {
  const current: Addresses = JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
  const [signer] = await ethers.getSigners();
  console.log(`Migrating as ${signer.address} on ${network.name}\n`);

  let moved = 0;
  moved += await migrateDrivers(current, process.env.OLD_DRIVERS);
  moved += await migrateVenues(current, process.env.OLD_VENUES);
  moved += await migrateRatings(current, process.env.OLD_RATINGS);

  if (!moved) {
    console.log(
      "Nothing migrated. Set OLD_DRIVERS, OLD_VENUES or OLD_RATINGS to the " +
        "contract being replaced."
    );
  } else {
    console.log(`\nDone. ${moved} records carried across and verified.`);
  }
}

/**
 * Everyone registered on `old`.
 *
 * There is no on-chain list of drivers — they are a mapping keyed by address —
 * so this casts as wide a net as it can and lets the contract do the deciding.
 * Every address appearing in any event the contract ever emitted is a
 * candidate; `registered` decides. `EXTRA_DRIVERS` (comma-separated) adds
 * anyone known to be missing, because on this chain a log can go astray.
 */
async function registeredDrivers(old: string): Promise<string[]> {
  const c = await ethers.getContractAt("PorterDrivers", old);
  const iface = c.interface;
  const logs = await ethers.provider.getLogs({
    address: old,
    fromBlock: 0,
    toBlock: "latest",
  });

  const candidates = new Set<string>();
  for (const l of logs) {
    const parsed = iface.parseLog({ topics: [...l.topics], data: l.data });
    if (!parsed) continue;
    for (const arg of parsed.args) {
      if (typeof arg === "string" && /^0x[0-9a-fA-F]{40}$/.test(arg)) {
        candidates.add(ethers.getAddress(arg));
      }
    }
  }
  for (const a of (process.env.EXTRA_DRIVERS ?? "").split(","))
    if (a.trim()) candidates.add(ethers.getAddress(a.trim()));

  const found: string[] = [];
  for (const a of candidates) {
    if ((await c.drivers(a)).registered) found.push(a);
  }
  console.log(
    `  ${candidates.size} addresses seen in events, ${found.length} registered`
  );
  return found;
}

/**
 * Every venue on `old`, read from storage rather than from logs.
 *
 * Venue ids are dense and `nextVenueId` bounds them, so the registry can be
 * walked directly — which is how venue #6 is found at all. Nothing here
 * depends on an event having survived.
 */
async function registeredVenues(old: string): Promise<bigint[]> {
  const c = await ethers.getContractAt("PorterVenues", old);
  const next = await c.nextVenueId();
  const ids: bigint[] = [];
  for (let id = 1n; id < next; id++) {
    if ((await c.venues(id)).operator !== ethers.ZeroAddress) ids.push(id);
  }
  console.log(`  ids 1..${next - 1n}, ${ids.length} occupied`);
  return ids;
}

/**
 * Push `items` in pages, splitting any page the chain refuses.
 *
 * The imports are paginated so an unbounded list cannot brick the migration,
 * but the page size that is safe is not knowable in advance. On Passet Hub the
 * binding limit is not EVM gas at all — 15 venues estimated at ~220k gas and
 * still failed with PolkaVM's `OutOfGas`, which is the per-transaction
 * PROOF SIZE. A batch of 50, sized for Ethereum, reverted; 12 was fine.
 *
 * Rather than hard-code a number that is wrong on the next chain or the next
 * record shape, each page is estimated first — a free call — and halved until
 * it fits. A page of one that still will not estimate is a real error and is
 * allowed to throw.
 */
async function inPages<T>(
  items: T[],
  estimate: (page: T[]) => Promise<bigint>,
  send: (page: T[], gasLimit: bigint) => Promise<{ wait: () => unknown }>
): Promise<void> {
  const queue: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH)
    queue.push(items.slice(i, i + BATCH));

  while (queue.length) {
    const page = queue.shift()!;
    let gas: bigint;
    try {
      gas = await estimate(page);
    } catch (e) {
      if (page.length === 1) throw e;
      const half = Math.ceil(page.length / 2);
      console.log(`  page of ${page.length} too big; splitting`);
      queue.unshift(page.slice(0, half), page.slice(half));
      continue;
    }
    // Headroom: the estimate is for the state as it is now, and earlier pages
    // in this same run will have changed it.
    const tx = await send(page, (gas * 3n) / 2n + 100_000n);
    await tx.wait();
    console.log(`  imported ${page.length}`);
  }
}

export async function migrateDrivers(cur: Addresses, old?: string): Promise<number> {
  if (!old) return 0;
  console.log(`drivers: ${old} -> ${cur.drivers}`);
  const who = await registeredDrivers(old);
  console.log(`  ${who.length} registrations to carry`);
  if (!who.length) return 0;

  const to = await ethers.getContractAt("PorterDrivers", cur.drivers);
  await inPages(
    who,
    (page) => to.importRecords.estimateGas(old, page),
    (page, gasLimit) => to.importRecords(old, page, { gasLimit })
  );

  // Read back. An import that skipped is indistinguishable from one that
  // worked until someone notices their rating is gone.
  const from = await ethers.getContractAt("PorterDrivers", old);
  let ok = 0;
  for (const a of who) {
    const [wasReg, , , , wasDelivered, wasFailed, wasUri] = await from.drivers(a);
    if (!wasReg) continue;
    const [isReg, , , , isDelivered, isFailed, isUri] = await to.drivers(a);
    if (
      isReg &&
      isDelivered === wasDelivered &&
      isFailed === wasFailed &&
      isUri === wasUri
    ) {
      ok++;
    } else {
      console.log(`  ! ${a} did not land intact`);
    }
  }
  console.log(`  verified ${ok}/${who.length}`);
  return ok;
}

export async function migrateVenues(cur: Addresses, old?: string): Promise<number> {
  if (!old) return 0;
  console.log(`venues: ${old} -> ${cur.venues}`);
  const ids = await registeredVenues(old);
  console.log(`  ${ids.length} venues to carry`);
  if (!ids.length) return 0;

  const to = await ethers.getContractAt("PorterVenues", cur.venues);
  await inPages(
    ids,
    (page) => to.importVenues.estimateGas(old, page),
    (page, gasLimit) => to.importVenues(old, page, { gasLimit })
  );

  const from = await ethers.getContractAt("PorterVenues", old);
  let ok = 0;
  for (const id of ids) {
    const was = await from.venues(id);
    const is = await to.venues(id);
    if (is.operator === was.operator && is.lat === was.lat && is.lon === was.lon) {
      ok++;
    } else {
      console.log(`  ! venue ${id} did not land intact`);
    }
  }
  console.log(`  verified ${ok}/${ids.length}`);
  return ok;
}

export async function migrateRatings(cur: Addresses, old?: string): Promise<number> {
  if (!old) return 0;
  console.log(`ratings: ${old} -> ${cur.ratings}`);
  // Who to carry comes from the registries, not from Ratings: a rating is
  // stored against a driver or a venue, and those are the enumerable lists.
  const who = process.env.OLD_DRIVERS
    ? await registeredDrivers(process.env.OLD_DRIVERS)
    : await registeredDrivers(cur.drivers);
  const ids = process.env.OLD_VENUES
    ? await registeredVenues(process.env.OLD_VENUES)
    : await registeredVenues(cur.venues);
  console.log(`  ${who.length} drivers, ${ids.length} venues to check`);

  const to = await ethers.getContractAt("PorterRatings", cur.ratings);
  const from = await ethers.getContractAt("PorterRatings", old);

  // Drivers and venues go in separate passes so a page can be split without
  // having to split two lists in step with each other.
  await inPages(
    who,
    (page) => to.importAggregates.estimateGas(old, page, []),
    (page, gasLimit) => to.importAggregates(old, page, [], { gasLimit })
  );
  await inPages(
    ids,
    (page) => to.importAggregates.estimateGas(old, [], page),
    (page, gasLimit) => to.importAggregates(old, [], page, { gasLimit })
  );

  let ok = 0;
  for (const a of who) {
    const was = await from.driverAgg(a);
    if (was.count === 0n) continue;
    const is = await to.driverAgg(a);
    if (is.sum === was.sum && is.count === was.count) ok++;
    else console.log(`  ! driver ${a} rating did not land intact`);
  }
  for (const id of ids) {
    const was = await from.venueAgg(id);
    if (was.count === 0n) continue;
    const is = await to.venueAgg(id);
    if (is.sum === was.sum && is.count === was.count) ok++;
    else console.log(`  ! venue ${id} rating did not land intact`);
  }
  console.log(`  verified ${ok} aggregates`);
  return ok;
}

// Importable as a library (scripts/upgrade-registries.ts calls the phases
// directly) as well as runnable on its own.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
