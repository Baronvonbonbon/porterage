// Carry reputation across a contract upgrade.
//
//   npx hardhat run scripts/migrate.ts --network polkadotTestnet
//
// The copy functions on PorterDrivers, PorterVenues and PorterRatings are
// paginated and onlyOwner, which means somebody has to enumerate the records
// and push them in batches. Nobody did, so the functions existed and the
// migration did not.
//
// The enumeration is off-chain and always was: `DriverRegistered` and
// `VenueRegistered` are the list. This reads them from the OLD contract, pages
// through the imports, and then READS BACK every record to check it landed.
// The read-back is the point. An import that silently skipped half its batch
// looks exactly like one that worked, and the failure surfaces weeks later as a
// driver whose rating vanished.
//
// Set OLD_DRIVERS / OLD_VENUES / OLD_RATINGS to the predecessors. Anything left
// unset is skipped, so one contract can be migrated at a time.

import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

const BATCH = 50;
const GAS_LIMIT = 3_000_000n;

const suffix = ["polkadotTestnet", "pine"].includes(network.name)
  ? ""
  : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);

type Addresses = Record<string, string>;

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

/** Every address that ever registered on `old`, oldest first, de-duplicated. */
async function registeredDrivers(old: string): Promise<string[]> {
  const c = await ethers.getContractAt("PorterDrivers", old);
  const logs = await c.queryFilter(c.filters.DriverRegistered(), 0, "latest");
  return [...new Set(logs.map((l) => l.args[0] as string))];
}

async function registeredVenues(old: string): Promise<bigint[]> {
  const c = await ethers.getContractAt("PorterVenues", old);
  const logs = await c.queryFilter(c.filters.VenueRegistered(), 0, "latest");
  return [...new Set(logs.map((l) => BigInt(l.args[0])))];
}

const pages = <T>(xs: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += BATCH) out.push(xs.slice(i, i + BATCH));
  return out;
};

async function migrateDrivers(cur: Addresses, old?: string): Promise<number> {
  if (!old) return 0;
  console.log(`drivers: ${old} -> ${cur.drivers}`);
  const who = await registeredDrivers(old);
  console.log(`  ${who.length} registrations to carry`);
  if (!who.length) return 0;

  const to = await ethers.getContractAt("PorterDrivers", cur.drivers);
  for (const page of pages(who)) {
    const tx = await to.importRecords(old, page, { gasLimit: GAS_LIMIT });
    await tx.wait();
    console.log(`  imported ${page.length}`);
  }

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

async function migrateVenues(cur: Addresses, old?: string): Promise<number> {
  if (!old) return 0;
  console.log(`venues: ${old} -> ${cur.venues}`);
  const ids = await registeredVenues(old);
  console.log(`  ${ids.length} venues to carry`);
  if (!ids.length) return 0;

  const to = await ethers.getContractAt("PorterVenues", cur.venues);
  for (const page of pages(ids)) {
    const tx = await to.importVenues(old, page, { gasLimit: GAS_LIMIT });
    await tx.wait();
    console.log(`  imported ${page.length}`);
  }

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

async function migrateRatings(cur: Addresses, old?: string): Promise<number> {
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

  for (let i = 0; i < Math.max(who.length, ids.length); i += BATCH) {
    const dPage = who.slice(i, i + BATCH);
    const vPage = ids.slice(i, i + BATCH);
    if (!dPage.length && !vPage.length) break;
    const tx = await to.importAggregates(old, dPage, vPage, {
      gasLimit: GAS_LIMIT,
    });
    await tx.wait();
    console.log(`  imported ${dPage.length} drivers, ${vPage.length} venues`);
  }

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

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
