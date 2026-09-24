import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { assignSealed } from "./helpers/bids";

// The rehearsal from docs/MIGRATION.md.
//
// A migration that has never been rehearsed is a plan, not a path. This is the
// acceptance test for the migration work: deploy, build up real reputation,
// upgrade all three registries, carry the records across, and check that what
// arrived is what left.
//
// It is deliberately end-to-end rather than three unit tests. Every real
// migration failure this is meant to catch — the half-erased driver whose
// deliveries survived but whose stars did not — is invisible when each import
// is checked in isolation, because each one is individually correct.
//
// upgradability.test.ts covers the freeze semantics themselves. This covers
// what an operator actually has to do on the day.

const VENUE_LAT = 37_774_900;
const VENUE_LON = -122_419_400;
const DROP_LAT = 37_784_900;
const DROP_LON = -122_419_400;
const SALT = 42n;
const abi = ethers.AbiCoder.defaultAbiCoder();
const name = (s: string) => ethers.encodeBytes32String(s);

const LOCATION_TYPES = {
  LocationAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "lat", type: "int32" },
    { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" },
  ],
};
const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

describe("Migration rehearsal", () => {
  async function deployAll() {
    const [deployer, treasury, customer, driver1, driver2, venueOp] =
      await ethers.getSigners();

    const router = await (await ethers.getContractFactory("PorterGovernanceRouter")).deploy();
    const pause = await (await ethers.getContractFactory("PorterPauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("PorterVault")).deploy();
    const drivers = await (await ethers.getContractFactory("PorterDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("PorterVenues")).deploy(pause.target);
    const orders = await (await ethers.getContractFactory("PorterOrders")).deploy(pause.target);
    const settlement = await (await ethers.getContractFactory("PorterSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("PorterDisputes")).deploy(pause.target);
    const ratings = await (await ethers.getContractFactory("PorterRatings")).deploy();
    const verifier = await (await ethers.getContractFactory("MockLocationVerifier")).deploy();

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await settlement.setLocationVerifier(verifier.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await ratings.configure(orders.target);
    await vault.setAuthorized(orders.target, true);
    await vault.setAuthorized(disputes.target, true);
    await drivers.setAuthorized(orders.target, true);
    await drivers.setAuthorized(disputes.target, true);
    await venues.setAuthorized(orders.target, true);

    for (const [n, c] of [
      ["pauseRegistry", pause], ["vault", vault], ["drivers", drivers],
      ["venues", venues], ["orders", orders], ["settlement", settlement],
      ["disputes", disputes], ["ratings", ratings],
    ] as const) {
      await router.register(name(n), c.target);
    }
    for (const c of [vault, drivers, venues, orders, settlement, disputes, ratings]) {
      await (c as any).setRouter(router.target);
    }

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = {
      name: "PorterSettlement", version: "1", chainId,
      verifyingContract: settlement.target as string,
    };

    return {
      deployer, treasury, customer, driver1, driver2, venueOp,
      router, pause, vault, drivers, venues, orders, settlement, disputes,
      ratings, domain,
    };
  }

  const dropCommit = () =>
    ethers.keccak256(abi.encode(["int32", "int32", "uint256"], [DROP_LAT, DROP_LON, SALT]));
  const driverCommit = (orderId: bigint) =>
    ethers.keccak256(abi.encode(["string", "uint256"], ["driver-pos", orderId]));
  const nullifierOf = (orderId: bigint) =>
    ethers.keccak256(abi.encode(["uint256", "uint256"], [SALT, orderId]));

  /** One order, driven to Delivered, so there is something real to rate. */
  async function deliver(
    f: Awaited<ReturnType<typeof deployAll>>,
    driver: (typeof f)["driver1"],
    venueId: bigint
  ) {
    await f.orders.connect(f.customer).createOrder(
      venueId, dropCommit(), 0, 0, ethers.parseEther("0.5"), 0, 0, { value: 0 }
    );
    const orderId = (await f.orders.nextOrderId()) - 1n;
    await assignSealed(f.orders, orderId, driver, f.customer, ethers.parseEther("0.3"));

    const now = await time.latest();
    const dPick = { orderId, phase: 1, actor: driver.address, lat: VENUE_LAT + 400, lon: VENUE_LON, timestamp: now };
    const vPick = { orderId, phase: 1, actor: f.venueOp.address, lat: VENUE_LAT, lon: VENUE_LON, timestamp: now };
    await f.settlement.confirmPickup(
      dPick, await driver.signTypedData(f.domain, LOCATION_TYPES, dPick),
      vPick, await f.venueOp.signTypedData(f.domain, LOCATION_TYPES, vPick)
    );

    const posCommit = driverCommit(orderId);
    const dDrop = { orderId, phase: 2, actor: driver.address, posCommit, timestamp: await time.latest() };
    const radius = await f.settlement.dropoffRadiusMeters();
    await f.settlement.confirmDropoffZK(
      dDrop, await driver.signTypedData(f.domain, DRIVER_COMMIT_TYPES, dDrop),
      "0x" + "00".repeat(256),
      [orderId, BigInt(dropCommit()), BigInt(posCommit), radius, BigInt(nullifierOf(orderId))]
    );
    expect(await f.orders.statusOf(orderId)).to.equal(4n); // Delivered
    return orderId;
  }

  /** Two drivers, one venue, real deliveries, real stars. */
  async function withHistory() {
    const f = await loadFixture(deployAll);
    await f.drivers.connect(f.driver1).register("ipfs://d1", { value: ethers.parseEther("1") });
    await f.drivers.connect(f.driver2).register("ipfs://d2");
    await f.venues.connect(f.venueOp).registerVenue(
      VENUE_LAT, VENUE_LON, f.venueOp.address, f.venueOp.address, "ipfs://v1"
    );

    const o1 = await deliver(f, f.driver1, 1n);
    const o2 = await deliver(f, f.driver2, 1n);
    const o3 = await deliver(f, f.driver1, 1n);

    await f.ratings.connect(f.customer).rate(o1, 5, 4);
    await f.ratings.connect(f.customer).rate(o2, 3, 5);
    await f.ratings.connect(f.customer).rate(o3, 4, 0); // venue skipped
    return f;
  }

  /** Fresh deployments of the three registries, wired and registered. */
  async function successors(f: Awaited<ReturnType<typeof withHistory>>) {
    const driversV2 = await (await ethers.getContractFactory("PorterDrivers")).deploy(f.pause.target);
    const venuesV2 = await (await ethers.getContractFactory("PorterVenues")).deploy(f.pause.target);
    const ratingsV2 = await (await ethers.getContractFactory("PorterRatings")).deploy();
    for (const c of [driversV2, venuesV2, ratingsV2]) await (c as any).setRouter(f.router.target);
    await ratingsV2.configure(f.orders.target);

    await f.router.upgradeContract(name("drivers"), driversV2.target, true);
    await f.router.upgradeContract(name("venues"), venuesV2.target, true);
    await f.router.upgradeContract(name("ratings"), ratingsV2.target, true);
    return { driversV2, venuesV2, ratingsV2 };
  }

  /** What the migration script does, minus the RPC. */
  async function carryAcross(
    f: Awaited<ReturnType<typeof withHistory>>,
    v2: Awaited<ReturnType<typeof successors>>
  ) {
    // The enumeration is the events, exactly as scripts/migrate.ts reads them.
    // If this ever stops finding everyone, the script has the same blind spot.
    const dLogs = await f.drivers.queryFilter(f.drivers.filters.DriverRegistered(), 0, "latest");
    const who = [...new Set(dLogs.map((l) => l.args[0] as string))];
    const vLogs = await f.venues.queryFilter(f.venues.filters.VenueRegistered(), 0, "latest");
    const ids = [...new Set(vLogs.map((l) => BigInt(l.args[0])))];

    await v2.driversV2.importRecords(f.drivers.target, who);
    await v2.venuesV2.importVenues(f.venues.target, ids);
    await v2.ratingsV2.importAggregates(f.ratings.target, who, ids);
    return { who, ids };
  }

  it("finds everyone from the events alone", async () => {
    // The whole migration rests on this: there is no on-chain enumeration, so
    // if the event log is not the complete list, records are silently left
    // behind and nothing anywhere reports it.
    const f = await withHistory();
    const v2 = await successors(f);
    const { who, ids } = await carryAcross(f, v2);
    expect(who).to.have.members([f.driver1.address, f.driver2.address]);
    expect(ids).to.deep.equal([1n]);
  });

  it("carries every registration, count, URI, pin and star across intact", async () => {
    const f = await withHistory();
    const v2 = await successors(f);
    await carryAcross(f, v2);

    for (const d of [f.driver1, f.driver2]) {
      const was = await f.drivers.drivers(d.address);
      const is = await v2.driversV2.drivers(d.address);
      expect(is.registered, `${d.address} registered`).to.equal(true);
      expect(is.delivered).to.equal(was.delivered);
      expect(is.failed).to.equal(was.failed);
      expect(is.metadataURI).to.equal(was.metadataURI);
      expect(is.banned).to.equal(was.banned);
    }
    // Deliveries actually happened, so the counters are not trivially zero.
    expect((await v2.driversV2.drivers(f.driver1.address)).delivered).to.equal(2);
    expect((await v2.driversV2.drivers(f.driver2.address)).delivered).to.equal(1);

    const wasV = await f.venues.venues(1n);
    const isV = await v2.venuesV2.venues(1n);
    expect(isV.operator).to.equal(wasV.operator);
    expect(isV.signer).to.equal(wasV.signer);
    expect(isV.payout).to.equal(wasV.payout);
    expect(isV.lat).to.equal(VENUE_LAT);
    expect(isV.lon).to.equal(VENUE_LON);
    expect(isV.pickups).to.equal(wasV.pickups);
    expect(isV.metadataURI).to.equal(wasV.metadataURI);
    expect(await v2.venuesV2.nextVenueId()).to.equal(2n);

    // The gap this work closed: stars used to be the one thing that vanished.
    const d1 = await v2.ratingsV2.driverAgg(f.driver1.address);
    expect([d1.sum, d1.count]).to.deep.equal([9n, 2n]); // 5 + 4
    const d2 = await v2.ratingsV2.driverAgg(f.driver2.address);
    expect([d2.sum, d2.count]).to.deep.equal([3n, 1n]);
    const v1 = await v2.ratingsV2.venueAgg(1n);
    expect([v1.sum, v1.count]).to.deep.equal([9n, 2n]); // 4 + 5, one skipped
  });

  it("stake stays behind and drains from the frozen predecessor", async () => {
    // Value is never copied — copying it would mean a privileged function that
    // writes balances, which is a function that can mint them.
    const f = await withHistory();
    const v2 = await successors(f);
    await carryAcross(f, v2);

    expect((await v2.driversV2.drivers(f.driver1.address)).stake).to.equal(0n);
    await f.drivers.connect(f.driver1).requestUnstake();
    await time.increase(3 * 24 * 3600 + 1);
    await expect(f.drivers.connect(f.driver1).withdrawStake()).to.changeEtherBalance(
      f.driver1,
      ethers.parseEther("1")
    );
  });

  it("is safe to run twice", async () => {
    // An operator whose script died mid-run will re-run it. If a second pass
    // moved anything, nobody could ever safely retry a partial migration.
    const f = await withHistory();
    const v2 = await successors(f);
    await carryAcross(f, v2);

    const before = [
      await v2.driversV2.drivers(f.driver1.address),
      await v2.venuesV2.venues(1n),
      await v2.ratingsV2.driverAgg(f.driver1.address),
      await v2.ratingsV2.venueAgg(1n),
    ].map(String);

    await carryAcross(f, v2);

    expect([
      await v2.driversV2.drivers(f.driver1.address),
      await v2.venuesV2.venues(1n),
      await v2.ratingsV2.driverAgg(f.driver1.address),
      await v2.ratingsV2.venueAgg(1n),
    ].map(String)).to.deep.equal(before);

    // Specifically: the venue's operator index is not doubled up, which a
    // naive re-import would do by pushing the id a second time.
    expect(await v2.venuesV2.venuesByOperator(f.venueOp.address, 0)).to.equal(1n);
    await expect(v2.venuesV2.venuesByOperator(f.venueOp.address, 1)).to.be.reverted;
  });

  it("never clobbers a record the successor already has", async () => {
    // Between the upgrade and the import there is a window in which people
    // register on the successor directly. An import that overwrote them would
    // roll them back to their older selves.
    const f = await withHistory();
    const v2 = await successors(f);

    await v2.driversV2.connect(f.driver1).register("ipfs://d1-new");
    await v2.ratingsV2.configure(f.orders.target);
    // A star on the successor, standing in for one earned in the window.
    const fresh = await deliver(f, f.driver1, 1n);
    await v2.ratingsV2.connect(f.customer).rate(fresh, 1, 1);

    await carryAcross(f, v2);

    const d = await v2.driversV2.drivers(f.driver1.address);
    expect(d.metadataURI).to.equal("ipfs://d1-new"); // not rolled back
    const agg = await v2.ratingsV2.driverAgg(f.driver1.address);
    expect([agg.sum, agg.count]).to.deep.equal([1n, 1n]); // the new one stands
  });

  it("leaves per-order replay protection behind, because the order ids move", async () => {
    // `rated` is per-order, and order ids are per-contract. Copying it to a
    // successor bound to a different orders contract would block ratings for
    // unrelated future orders that happen to reuse the number.
    const f = await withHistory();
    const v2 = await successors(f);
    await carryAcross(f, v2);
    expect(await f.ratings.rated(1n)).to.equal(true);
    expect(await v2.ratingsV2.rated(1n)).to.equal(false);
  });

  it("the frozen predecessors refuse new entries once upgraded", async () => {
    const f = await withHistory();
    await successors(f);
    await expect(
      f.drivers.connect(f.treasury).register("ipfs://late")
    ).to.be.revertedWith("frozen");
    await expect(
      f.venues.connect(f.venueOp).registerVenue(VENUE_LAT, VENUE_LON, f.venueOp.address, f.venueOp.address, "x")
    ).to.be.revertedWith("frozen");
  });
});
