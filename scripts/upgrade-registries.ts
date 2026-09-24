// Upgrade drivers, venues and ratings, carrying reputation across.
//
//   npx hardhat run scripts/upgrade-registries.ts --network polkadotTestnet
//
// The whole freeze-and-drain sequence from docs/MIGRATION.md, in the order
// that keeps the system consistent at every step:
//
//   1. deploy the successors and wire them — they are inert until promoted
//   2. `router.upgradeContract(name, v2, freezeOld: true)`, which freezes the
//      predecessor against NEW entries while leaving its exits open
//   3. carry the records across, and read every one of them back
//   4. only then re-point the dependents (orders, settlement, disputes)
//
// Step 4 comes last on purpose. Re-pointing first would leave a window where
// orders is asking an empty registry whether a driver is registered, and every
// bid in that window would be refused for a reason nobody could see.
//
// Nothing is written to the address books until the migration has verified.

import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import {
  migrateDrivers,
  migrateRatings,
  migrateVenues,
  type Addresses,
} from "./migrate";

const GAS_LIMIT = 3_000_000n;
const NAMES = ["drivers", "venues", "ratings"] as const;

const suffix = ["polkadotTestnet", "pine"].includes(network.name)
  ? ""
  : `.${network.name}`;
const ADDR_FILE = path.join(__dirname, "..", `deployed-addresses${suffix}.json`);
const WEB_FILE = path.join(__dirname, "..", "web", "src", "deployed.json");

async function send(label: string, fn: () => Promise<{ wait: () => unknown }>) {
  process.stdout.write(`  ${label} … `);
  const tx = await fn();
  await tx.wait();
  console.log("ok");
}

async function main() {
  const cur: Addresses = JSON.parse(fs.readFileSync(ADDR_FILE, "utf-8"));
  const [deployer] = await ethers.getSigners();
  const before = await ethers.provider.getBalance(deployer.address);
  console.log(
    `Upgrading as ${deployer.address} on ${network.name}` +
      ` (${ethers.formatEther(before)} PAS)\n`
  );

  const old = { drivers: cur.drivers, venues: cur.venues, ratings: cur.ratings };
  for (const n of NAMES) console.log(`  ${n} v1 ${old[n]}`);

  const router = await ethers.getContractAt(
    "PorterGovernanceRouter",
    cur.router,
    deployer
  );

  // Resume, rather than start again.
  //
  // A migration is exactly the kind of job that dies halfway — this one did,
  // on a page size the chain refused — and re-running it must not deploy a
  // second set of successors and orphan the records already carried into the
  // first. The router is the record of what has been promoted: if it points
  // `drivers` somewhere other than the address book does, that successor
  // exists and has been promoted already.
  const promoted: Partial<Record<(typeof NAMES)[number], string>> = {};
  for (const n of NAMES) {
    const at = await router.currentAddrOf(ethers.encodeBytes32String(n));
    if (at !== ethers.ZeroAddress && at !== cur[n]) {
      promoted[n] = at;
      console.log(`  ${n} already promoted to ${at} — resuming`);
    }
  }

  // ── 1. deploy and wire the successors ────────────────────────────────────
  console.log("\n1. Deploying successors");
  const deployNew = async (name: string, factory: string, args: unknown[]) => {
    if (promoted[name as (typeof NAMES)[number]]) {
      const at = promoted[name as (typeof NAMES)[number]]!;
      console.log(`  ${name}  = ${at} (already deployed)`);
      return ethers.getContractAt(factory, at, deployer);
    }
    const c = await (
      await ethers.getContractFactory(factory)
    ).deploy(...args, { gasLimit: 6_000_000n });
    await c.waitForDeployment();
    console.log(`  ${name}  ${await c.getAddress()}`);
    return c;
  };

  const driversV2 = (await deployNew("drivers", "PorterDrivers", [
    cur.pauseRegistry,
  ])) as Awaited<ReturnType<typeof ethers.getContractAt>>;
  const venuesV2 = await deployNew("venues", "PorterVenues", [
    cur.pauseRegistry,
  ]);
  const ratingsV2 = await deployNew("ratings", "PorterRatings", []);

  const next: Addresses = {
    ...cur,
    drivers: await driversV2.getAddress(),
    venues: await venuesV2.getAddress(),
    ratings: await ratingsV2.getAddress(),
  };

  console.log("\n2. Wiring them (still inert — the registry has not moved)");
  // Every step below is checked before it is sent, so a resumed run re-does
  // nothing and a first run does everything.
  const ensure = async (
    label: string,
    done: () => Promise<boolean>,
    act: () => Promise<{ wait: () => unknown }>
  ) => {
    if (await done()) return console.log(`  = ${label} already done`);
    await send(label, act);
  };

  for (const [label, c] of [
    ["drivers", driversV2],
    ["venues", venuesV2],
    ["ratings", ratingsV2],
  ] as const) {
    await ensure(
      `${label}.setRouter`,
      async () => (await (c as any).router()) !== ethers.ZeroAddress,
      () => (c as any).setRouter(cur.router, { gasLimit: GAS_LIMIT })
    );
  }
  await ensure(
    "ratings.configure(orders)",
    async () => (await (ratingsV2 as any).orders()) === cur.orders,
    () => (ratingsV2 as any).configure(cur.orders, { gasLimit: GAS_LIMIT })
  );
  for (const who of ["orders", "disputes"] as const) {
    await ensure(
      `drivers.setAuthorized(${who})`,
      () => (driversV2 as any).authorized(cur[who]),
      () => (driversV2 as any).setAuthorized(cur[who], true, { gasLimit: GAS_LIMIT })
    );
  }
  await ensure(
    "venues.setAuthorized(orders)",
    () => (venuesV2 as any).authorized(cur.orders),
    () => (venuesV2 as any).setAuthorized(cur.orders, true, { gasLimit: GAS_LIMIT })
  );

  // ── 3. promote: freeze v1 against new entries, re-point the registry ─────
  console.log("\n3. Promoting through the router (freezing each predecessor)");
  for (const n of NAMES) {
    await ensure(
      `router.upgradeContract(${n})`,
      async () =>
        (await router.currentAddrOf(ethers.encodeBytes32String(n))) === next[n],
      () =>
        router.upgradeContract(ethers.encodeBytes32String(n), next[n]!, true, {
          gasLimit: GAS_LIMIT,
        })
    );
  }

  // ── 4. carry the records ─────────────────────────────────────────────────
  console.log("\n4. Carrying records across");
  const moved =
    (await migrateDrivers(next, old.drivers)) +
    (await migrateVenues(next, old.venues)) +
    (await migrateRatings(next, old.ratings));
  if (!moved) throw new Error("nothing migrated — refusing to re-point");

  // ── 5. re-point the dependents ───────────────────────────────────────────
  console.log("\n5. Re-pointing dependents");
  const orders = await ethers.getContractAt("PorterOrders", cur.orders, deployer);
  // Read these rather than guess them: neither is changing here, and a wrong
  // treasury would silently redirect every protocol fee.
  const treasury = await orders.treasury();
  await send("orders.configure", () =>
    orders.configure(
      cur.vault,
      next.drivers,
      next.venues,
      cur.settlement,
      cur.disputes,
      treasury,
      { gasLimit: GAS_LIMIT }
    )
  );
  const settlement = await ethers.getContractAt(
    "PorterSettlement",
    cur.settlement,
    deployer
  );
  await send("settlement.configure", () =>
    settlement.configure(cur.orders, next.venues, { gasLimit: GAS_LIMIT })
  );
  await send("settlement.setDrivers", () =>
    settlement.setDrivers(next.drivers, { gasLimit: GAS_LIMIT })
  );
  const disputes = await ethers.getContractAt(
    "PorterDisputes",
    cur.disputes,
    deployer
  );
  const disputeTreasury = await disputes.treasury();
  await send("disputes.configure", () =>
    disputes.configure(
      cur.orders,
      cur.vault,
      next.drivers,
      disputeTreasury,
      { gasLimit: GAS_LIMIT }
    )
  );

  // ── 6. check it ──────────────────────────────────────────────────────────
  console.log("\n6. Validating");
  const checks: Array<[string, boolean]> = [
    ["orders.drivers", (await orders.drivers()) === next.drivers],
    ["orders.venues", (await orders.venues()) === next.venues],
    ["settlement.venues", (await settlement.venues()) === next.venues],
    ["settlement.drivers", (await settlement.drivers()) === next.drivers],
    ["disputes.drivers", (await disputes.drivers()) === next.drivers],
    ["ratings.orders", (await ratingsV2.orders()) === cur.orders],
    [
      "drivers authorizes orders",
      await driversV2.authorized(cur.orders),
    ],
    [
      "drivers authorizes disputes",
      await driversV2.authorized(cur.disputes),
    ],
    ["venues authorizes orders", await venuesV2.authorized(cur.orders)],
  ];
  for (const n of NAMES) {
    const oldC = await ethers.getContractAt("PorterVault", old[n]!);
    const newC = await ethers.getContractAt("PorterVault", next[n]!);
    checks.push([`${n} v1 frozen`, await oldC.frozen()]);
    checks.push([`${n} v2 not frozen`, !(await newC.frozen())]);
    checks.push([
      `router points ${n} at v2`,
      (await router.currentAddrOf(ethers.encodeBytes32String(n))) === next[n],
    ]);
  }
  let bad = 0;
  for (const [what, ok] of checks) {
    console.log(`  ${ok ? "✓" : "✗"} ${what}`);
    if (!ok) bad++;
  }
  if (bad) throw new Error(`${bad} checks failed — address books NOT updated`);

  // ── 7. write the address books ───────────────────────────────────────────
  fs.writeFileSync(ADDR_FILE, JSON.stringify(next, null, 2) + "\n");
  const web = JSON.parse(fs.readFileSync(WEB_FILE, "utf-8"));
  for (const n of NAMES) web[n] = next[n];
  fs.writeFileSync(WEB_FILE, JSON.stringify(web, null, 2) + "\n");
  console.log(`\nWrote ${ADDR_FILE} and ${WEB_FILE}`);

  const after = await ethers.provider.getBalance(deployer.address);
  console.log(`Spent ${ethers.formatEther(before - after)} PAS`);
  console.log("\nDone. Rebuild and republish the app.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
