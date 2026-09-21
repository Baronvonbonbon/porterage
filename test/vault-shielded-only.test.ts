// The vault ships shielded-only, and this is the test that keeps it that way.
//
// Every other suite in this repo opens `clearExitsOpen` in its fixture, because
// most of them are testing the named-address withdrawal machinery and cannot
// test it through a shut door. That is convenient and it is also exactly how a
// default quietly stops being the default: the whole suite passes with the gate
// open, nobody notices it was never shut, and a deploy ships with value able to
// walk out to an address that identifies the person earning it.
//
// So this file deploys the vault the way the deploy script does — untouched —
// and asserts what an ordinary participant can and cannot do with it.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { poseidonContract } from "circomlibjs";

describe("the vault is shielded-only by default", () => {
  async function bareVault() {
    const [owner, payee, relay] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("PorterVault")).deploy();
    // `owner` stands in for the orders contract: something authorized has to
    // put a balance here before there is anything to try to withdraw.
    await vault.setAuthorized(owner.address, true);
    await vault.credit(payee.address, { value: ethers.parseEther("10") });
    return { vault, owner, payee, relay };
  }

  it("ships shut, with nothing to do to make it so", async () => {
    const { vault } = await loadFixture(bareVault);
    expect(await vault.clearExitsOpen()).to.equal(false);
  });

  it("refuses to move earnings to a named address", async () => {
    // The point of the whole design: a driver's earnings must not be able to
    // land in the account everyone knows is theirs, in an amount that says how
    // much work they did.
    const { vault, payee, relay } = await loadFixture(bareVault);
    await expect(vault.connect(payee).withdraw()).to.be.revertedWith(
      "shielded-only"
    );
    await expect(
      vault.connect(payee).withdrawTo(relay.address)
    ).to.be.revertedWith("shielded-only");
    await expect(
      vault.connect(payee).withdrawToken(ethers.ZeroAddress)
    ).to.be.revertedWith("shielded-only");
    await expect(
      vault.connect(payee).withdrawTokenTo(ethers.ZeroAddress, relay.address)
    ).to.be.revertedWith("shielded-only");
  });

  it("refuses the gasless named-address path too, before it checks the signature", async () => {
    // A relay-submitted withdrawal is still a withdrawal to a named address.
    // It has to fail on the gate rather than on the signature, or a valid
    // signature would be the only thing standing between here and a leak.
    const { vault, payee, relay } = await loadFixture(bareVault);
    await expect(
      vault
        .connect(relay)
        .withdrawFor(payee.address, relay.address, 2n ** 40n, "0x00")
    ).to.be.revertedWith("shielded-only");
    await expect(
      vault
        .connect(relay)
        .withdrawForToken(
          ethers.ZeroAddress,
          payee.address,
          relay.address,
          2n ** 40n,
          "0x00"
        )
    ).to.be.revertedWith("shielded-only");
  });

  it("leaves the shielded exit open — money can always leave, just not in the clear", async () => {
    // The gate must never reach `insertShieldNote`. If it ever did, a shut
    // vault would be a trapped one, and this contract's rule is that nothing
    // is ever trapped.
    const { vault, payee } = await loadFixture(bareVault);
    const [owner] = await ethers.getSigners();
    const impl = await new ethers.ContractFactory(
      poseidonContract.generateABI(2),
      poseidonContract.createCode(2),
      owner
    ).deploy();
    const poseidon = await (
      await ethers.getContractFactory("PoseidonT3Adapter")
    ).deploy(await impl.getAddress());
    await vault.setShieldBuckets([ethers.parseEther("1")]);
    await vault.setShieldPoseidon(poseidon.target);

    await expect(
      vault.connect(payee).insertShieldNote(ethers.parseEther("1"), 12345n)
    ).to.not.be.reverted;
    expect(await vault.balanceOf(payee.address)).to.equal(
      ethers.parseEther("9")
    );
  });

  it("lets governance open the door, and nobody else", async () => {
    // Not a convenience: if the shield pool were ever broken or its verifying
    // key wrong, this is what stops every balance being stranded for good.
    const { vault, payee } = await loadFixture(bareVault);
    await expect(vault.connect(payee).setClearExits(true)).to.be.reverted;

    await vault.setClearExits(true);
    await expect(vault.connect(payee).withdraw()).to.not.be.reverted;
    expect(await vault.balanceOf(payee.address)).to.equal(0n);
  });
});
