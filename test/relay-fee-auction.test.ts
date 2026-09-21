// The relay's fee is an auction, not a price.
//
// A relay settles the dropoff and pays the gas for it. That used to earn a flat
// governance-set number, which is either too high (every customer overpays on
// every order) or too low (nothing settles and the gasless path quietly stops
// working), with no way to tell which until someone complains.
//
// Now the customer escrows a CEILING and the fee climbs to it from a floor,
// starting when the driver signed at the door. The first relay willing to take
// the price settles, so the cheapest operator wins, and the customer gets back
// whatever the climb never reached.
//
// These tests are on `relayFeeAt` directly, because it is pure arithmetic that
// decides what strangers get paid and what customers get refunded, and it is
// much easier to be sure of here than through a full settlement.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const CAP = ethers.parseEther("0.5");

describe("the relay fee curve", () => {
  async function bareOrders() {
    const pause = await (
      await ethers.getContractFactory("PorterPauseRegistry")
    ).deploy();
    const orders = await (
      await ethers.getContractFactory("PorterOrders")
    ).deploy(pause.target);
    return { orders };
  }

  it("ships at 3750 bps over 30 s — a 1.5x floor under a 4x ceiling", async () => {
    // The same tuning as the off-chain market in web/src/market/auction.ts. If
    // these drift apart, a relay and a withdrawal submitter are being paid on
    // different theories for the same kind of work.
    const { orders } = await loadFixture(bareOrders);
    expect(await orders.relayFeeFloorBps()).to.equal(3_750);
    expect(await orders.relayFeeClimbSecs()).to.equal(30);
  });

  it("opens at the floor and ends at the ceiling", async () => {
    const { orders } = await loadFixture(bareOrders);
    expect(await orders.relayFeeAt(CAP, 1000, 1000)).to.equal(
      (CAP * 3_750n) / 10_000n
    );
    expect(await orders.relayFeeAt(CAP, 1000, 1030)).to.equal(CAP);
  });

  it("never pays more than the customer escrowed, however late", async () => {
    // This is the customer's protection and the conservation guarantee both:
    // paying over the cap would overdraw the order's escrow.
    const { orders } = await loadFixture(bareOrders);
    expect(await orders.relayFeeAt(CAP, 1000, 1_000_000)).to.equal(CAP);
  });

  it("never pays less than the floor, even on a backwards clock", async () => {
    // The start comes from a phone's signed timestamp and the end from the
    // chain. They can disagree; a relay must not be paid below the floor when
    // they do.
    const { orders } = await loadFixture(bareOrders);
    const floor = (CAP * 3_750n) / 10_000n;
    expect(await orders.relayFeeAt(CAP, 1000, 999)).to.equal(floor);
    expect(await orders.relayFeeAt(CAP, 1000, 0)).to.equal(floor);
  });

  it("rises monotonically across the window", async () => {
    const { orders } = await loadFixture(bareOrders);
    let last = 0n;
    for (let t = 995; t <= 1035; t++) {
      const p = await orders.relayFeeAt(CAP, 1000, t);
      expect(p).to.be.gte(last);
      last = p;
    }
  });

  it("is halfway up at halfway through", async () => {
    const { orders } = await loadFixture(bareOrders);
    const floor = (CAP * 3_750n) / 10_000n;
    expect(await orders.relayFeeAt(CAP, 1000, 1015)).to.equal(
      floor + (CAP - floor) / 2n
    );
  });

  it("pays nothing when the ceiling is zero, which is the dormant default", async () => {
    const { orders } = await loadFixture(bareOrders);
    expect(await orders.relayFeeAt(0, 1000, 1030)).to.equal(0);
  });

  it("restores the old flat fee exactly when governance zeroes the climb", async () => {
    // The escape hatch. If the curve turns out to be a bad idea in practice,
    // this rail goes back to what it did before without a redeploy.
    const { orders } = await loadFixture(bareOrders);
    await orders.setRelayFeeCurve(3_750, 0);
    expect(await orders.relayFeeAt(CAP, 1000, 1000)).to.equal(CAP);
    expect(await orders.relayFeeAt(CAP, 1000, 1_000_000)).to.equal(CAP);
  });

  it("is flat at the cap when the floor is the whole of it", async () => {
    const { orders } = await loadFixture(bareOrders);
    await orders.setRelayFeeCurve(10_000, 30);
    expect(await orders.relayFeeAt(CAP, 1000, 1000)).to.equal(CAP);
    expect(await orders.relayFeeAt(CAP, 1000, 1015)).to.equal(CAP);
  });

  it("refuses a floor above the ceiling it is a share of", async () => {
    const { orders } = await loadFixture(bareOrders);
    await expect(orders.setRelayFeeCurve(10_001, 30)).to.be.revertedWith(
      "bad-bps"
    );
  });

  it("is governance-only", async () => {
    const { orders } = await loadFixture(bareOrders);
    const [, stranger] = await ethers.getSigners();
    await expect(orders.connect(stranger).setRelayFeeCurve(5_000, 30)).to.be
      .reverted;
  });
});
