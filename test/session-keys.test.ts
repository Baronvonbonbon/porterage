import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — no types
import * as snarkjs from "snarkjs";
import { poseidon2, poseidon3 } from "poseidon-lite";

// Session keys (docs/PLAN.md §3.2).
//
// A driver's identity is their Polkadot app account, which signs sr25519 and
// needs a tap per signature. In these tests the driver's own signer stands in
// for that account and is NEVER used to sign an attestation: every signature a
// delivery needs comes from the session key the account registered. The claims:
//
//   - a delivery settles end to end with only session-key signatures
//   - without the driver registry wired into settlement, they don't count
//   - rotating the key retires the old one at once; clearing it retires both
//   - a key serves one driver, is never a driver itself, and never the driver
//   - the session key can send the driver's day-to-day calls (abandon, evidence),
//     and a stranger can't

const PAS = (n: string | number) => ethers.parseEther(String(n));
const b32 = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const rand = () => ethers.toBigInt(ethers.randomBytes(31));
const encLat = (l: number) => BigInt(l) + 90_000_000n;
const encLon = (l: number) => BigInt(l) + 180_000_000n;
const positionCommit = (lat: number, lon: number, salt: bigint) => poseidon3([encLat(lat), encLon(lon), salt]);

const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const ORDER_VALUE = PAS(1);
const FARE = PAS(2);
const RADIUS = 100;
const Status = { Assigned: 2, PickedUp: 3, Delivered: 4, Cancelled: 5 } as const;

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

async function prove(orderId: bigint, dropCommit: string, dropSalt: bigint, drvSalt: bigint) {
  const driverCommit = b32(positionCommit(DROP.lat, DROP.lon, drvSalt));
  const nullifier = b32(poseidon2([dropSalt, orderId]));
  const zk = await snarkjs.groth16.fullProve(
    {
      orderId: orderId.toString(),
      dropCommit: BigInt(dropCommit).toString(),
      driverCommit: BigInt(driverCommit).toString(),
      radiusMeters: String(RADIUS),
      nullifier: BigInt(nullifier).toString(),
      custLatEnc: encLat(DROP.lat).toString(),
      custLonEnc: encLon(DROP.lon).toString(),
      salt: dropSalt.toString(),
      drvLatEnc: encLat(DROP.lat).toString(),
      drvLonEnc: encLon(DROP.lon).toString(),
      drvSalt: drvSalt.toString(),
    },
    join(__dirname, "..", "circuits", "build", "proximity_js", "proximity.wasm"),
    join(__dirname, "..", "circuits", "build", "proximity.zkey")
  );
  const proof = ethers.solidityPacked(Array(8).fill("uint256"), [
    zk.proof.pi_a[0], zk.proof.pi_a[1], zk.proof.pi_b[0][1], zk.proof.pi_b[0][0],
    zk.proof.pi_b[1][1], zk.proof.pi_b[1][0], zk.proof.pi_c[0], zk.proof.pi_c[1],
  ]);
  const pub = [orderId.toString(), BigInt(dropCommit).toString(), BigInt(driverCommit).toString(), String(RADIUS), BigInt(nullifier).toString()];
  return { proof, pub, driverCommit };
}

describe("session keys", function () {
  this.timeout(240_000);

  let orders: any, settlement: any, venues: any, drivers: any, disputes: any;
  let deployer: HardhatEthersSigner, treasury: HardhatEthersSigner, driver: HardhatEthersSigner,
      venueOp: HardhatEthersSigner, venueSigner: HardhatEthersSigner, stranger: HardhatEthersSigner,
      otherDriver: HardhatEthersSigner;
  let customer: ethers.Wallet, sessionKey: ethers.Wallet;
  let domain: any;

  async function newWallet(fund = PAS(5)) {
    const w = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, ethers.provider);
    if (fund > 0n) await deployer.sendTransaction({ to: w.address, value: fund });
    return w;
  }

  // An order assigned to `driver`, with the drop committed under `dropSalt`.
  async function assignedOrder() {
    const dropSalt = rand();
    const dropCommit = b32(positionCommit(DROP.lat, DROP.lon, dropSalt));
    await orders.connect(customer).createOrder(1n, dropCommit, ORDER_VALUE, 0, FARE, 0, 0, { value: ORDER_VALUE });
    const orderId = (await orders.nextOrderId()) - 1n;
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const bidHash = await orders.bidHashOf(orderId, driver.address, FARE, salt);
    // The session key commits the bid: commitBid names nobody, so no host tap.
    await orders.connect(sessionKey).commitBid(orderId, bidHash, ethers.keccak256(ethers.toUtf8Bytes("revoke")));
    await orders.connect(customer).acceptSealedBid(orderId, driver.address, FARE, salt, { value: FARE });
    return { orderId, dropSalt, dropCommit };
  }

  async function pickupAtts(orderId: bigint, driverKey: { signTypedData: Function }) {
    const [lat, lon] = await venues.locationOf(1n);
    const now = await time.latest();
    const dAtt = { orderId, phase: 1, actor: driver.address, lat, lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: venueSigner.address, lat, lon, timestamp: now };
    return [
      dAtt, await driverKey.signTypedData(domain, LOCATION_TYPES, dAtt),
      vAtt, await venueSigner.signTypedData(domain, LOCATION_TYPES, vAtt),
    ] as const;
  }

  beforeEach(async () => {
    [deployer, treasury, driver, venueOp, venueSigner, stranger, otherDriver] = await ethers.getSigners();
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const pause = await (await ethers.getContractFactory("PorterPauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("PorterVault")).deploy();
    drivers = await (await ethers.getContractFactory("PorterDrivers")).deploy(pause.target);
    venues = await (await ethers.getContractFactory("PorterVenues")).deploy(pause.target);
    orders = await (await ethers.getContractFactory("PorterOrders")).deploy(pause.target);
    settlement = await (await ethers.getContractFactory("PorterSettlement")).deploy(pause.target);
    disputes = await (await ethers.getContractFactory("PorterDisputes")).deploy(pause.target);
    const verifier = await (await ethers.getContractFactory("PorterLocationVerifier")).deploy();
    const vk = JSON.parse(readFileSync(join(__dirname, "fixtures", "zk-proximity.json"), "utf8")).vkCalldata;
    await verifier.setVerifyingKey(vk.alpha1, vk.beta2, vk.gamma2, vk.delta2, vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, vk.IC5);

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await settlement.setLocationVerifier(verifier.target);
    await settlement.setDrivers(drivers.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);

    sessionKey = await newWallet();
    customer = await newWallet(PAS(20));
    await expect(drivers.connect(driver).registerWithSessionKey("ipfs://driver", sessionKey.address, { value: PAS(1) }))
      .to.emit(drivers, "SessionKeySet").withArgs(driver.address, sessionKey.address);
    await venues.connect(venueOp).registerVenue(VENUE.lat, VENUE.lon, venueSigner.address, venueOp.address, "ipfs://venue");
    domain = { name: "PorterSettlement", version: "1", chainId, verifyingContract: settlement.target as string };
  });

  it("a delivery settles with only session-key signatures", async () => {
    const { orderId, dropSalt, dropCommit } = await assignedOrder();
    expect(await drivers.actsFor(sessionKey.address, driver.address)).to.equal(true);

    // Pickup, sent by the session key itself.
    await settlement.connect(sessionKey).confirmPickup(...(await pickupAtts(orderId, sessionKey)));
    expect(await orders.statusOf(orderId)).to.equal(Status.PickedUp);

    // Dropoff: the session key signs the customer-built commitment.
    const { proof, pub, driverCommit } = await prove(orderId, dropCommit, dropSalt, rand());
    const att = { orderId, phase: 2, actor: driver.address, posCommit: driverCommit, timestamp: await time.latest() };
    await settlement.connect(customer).confirmDropoffZK(
      att, await sessionKey.signTypedData(domain, DRIVER_COMMIT_TYPES, att), proof, pub
    );
    expect(await orders.statusOf(orderId)).to.equal(Status.Delivered);
  });

  it("without the driver registry wired in, a session-key signature doesn't count", async () => {
    const bare = await (await ethers.getContractFactory("PorterSettlement")).deploy(await settlement.pauseRegistry());
    await bare.configure(orders.target, venues.target);
    await orders.configure(await orders.vault(), drivers.target, venues.target, bare.target, await orders.disputes(), treasury.address);
    const { orderId } = await assignedOrder();
    const chainId = (await ethers.provider.getNetwork()).chainId;
    domain = { name: "PorterSettlement", version: "1", chainId, verifyingContract: bare.target as string };
    await expect(bare.confirmPickup(...(await pickupAtts(orderId, sessionKey)))).to.be.revertedWith("bad-signature");
    // The driver's own key still works there.
    await bare.confirmPickup(...(await pickupAtts(orderId, driver)));
    expect(await orders.statusOf(orderId)).to.equal(Status.PickedUp);
  });

  it("rotating the key retires the old one at once", async () => {
    const { orderId } = await assignedOrder();
    const next = await newWallet(0n);
    await drivers.connect(driver).setSessionKey(next.address);
    expect(await drivers.driverOfSessionKey(sessionKey.address)).to.equal(ethers.ZeroAddress);
    await expect(settlement.confirmPickup(...(await pickupAtts(orderId, sessionKey)))).to.be.revertedWith("bad-signature");
    await settlement.confirmPickup(...(await pickupAtts(orderId, next)));
    expect(await orders.statusOf(orderId)).to.equal(Status.PickedUp);
  });

  it("clearing the key leaves only the driver's own", async () => {
    const { orderId } = await assignedOrder();
    await drivers.connect(driver).setSessionKey(ethers.ZeroAddress);
    expect(await drivers.sessionKeyOf(driver.address)).to.equal(ethers.ZeroAddress);
    expect(await drivers.actsFor(ethers.ZeroAddress, driver.address)).to.equal(false);
    await expect(settlement.confirmPickup(...(await pickupAtts(orderId, sessionKey)))).to.be.revertedWith("bad-signature");
  });

  it("a key serves one driver, is never a driver, and is never the driver itself", async () => {
    await drivers.connect(otherDriver).register("ipfs://other");
    await expect(drivers.connect(otherDriver).setSessionKey(sessionKey.address)).to.be.revertedWith("key-in-use");
    await expect(drivers.connect(driver).setSessionKey(otherDriver.address)).to.be.revertedWith("key-is-a-driver");
    await expect(drivers.connect(driver).setSessionKey(driver.address)).to.be.revertedWith("key-is-driver");
    await expect(drivers.connect(stranger).setSessionKey(stranger.address)).to.be.revertedWith("not-registered");
  });

  it("the session key can abandon for the driver; a stranger can't", async () => {
    const { orderId } = await assignedOrder();
    await expect(orders.connect(stranger).abandonOrder(orderId)).to.be.revertedWith("not-driver");
    await orders.connect(sessionKey).abandonOrder(orderId);
    expect(await orders.statusOf(orderId)).to.equal(Status.Cancelled);
    const [, failed] = await drivers.reputationOf(driver.address);
    expect(failed).to.equal(1);
  });

  it("another driver's session key can't sign for this driver", async () => {
    const theirs = await newWallet(0n);
    await drivers.connect(otherDriver).registerWithSessionKey("ipfs://other", theirs.address);
    const { orderId } = await assignedOrder();
    await expect(settlement.confirmPickup(...(await pickupAtts(orderId, theirs)))).to.be.revertedWith("bad-signature");
  });
  describe("evidence committed at event time", () => {
    const photo = ethers.keccak256(ethers.toUtf8Bytes("sealed delivery photo"));

    it("the session key commits the driver's evidence, recorded under the driver", async () => {
      const { orderId } = await assignedOrder();
      await settlement.confirmPickup(...(await pickupAtts(orderId, sessionKey)));
      await expect(disputes.connect(sessionKey).commitEvidence(orderId, photo))
        .to.emit(disputes, "EvidenceCommitted").withArgs(orderId, driver.address, photo);
      const e = await disputes.evidenceOf(orderId, driver.address);
      expect(e.key).to.equal(photo);
      expect(e[1]).to.equal(await time.latest()); // e.at is ethers Result.at(), not the field
    });

    it("a committed key can't be swapped later, by either key", async () => {
      const { orderId } = await assignedOrder();
      await disputes.connect(sessionKey).commitEvidence(orderId, photo);
      const other = ethers.keccak256(ethers.toUtf8Bytes("a different photo"));
      await expect(disputes.connect(sessionKey).commitEvidence(orderId, other)).to.be.revertedWith("already-committed");
      await expect(disputes.connect(driver).commitEvidence(orderId, other)).to.be.revertedWith("already-committed");
    });

    it("the customer commits its own; strangers and settled orders are refused", async () => {
      const { orderId, dropSalt, dropCommit } = await assignedOrder();
      await expect(disputes.connect(stranger).commitEvidence(orderId, photo)).to.be.revertedWith("not-party");
      await disputes.connect(customer).commitEvidence(orderId, photo);
      expect((await disputes.evidenceOf(orderId, customer.address)).key).to.equal(photo);

      await settlement.confirmPickup(...(await pickupAtts(orderId, sessionKey)));
      const { proof, pub, driverCommit } = await prove(orderId, dropCommit, dropSalt, rand());
      const att = { orderId, phase: 2, actor: driver.address, posCommit: driverCommit, timestamp: await time.latest() };
      await settlement.confirmDropoffZK(att, await sessionKey.signTypedData(domain, DRIVER_COMMIT_TYPES, att), proof, pub);
      await expect(disputes.connect(sessionKey).commitEvidence(orderId, photo)).to.be.revertedWith("bad-status");
    });
  });
});
