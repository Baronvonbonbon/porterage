// Paying a stranger to front gas, without telling anyone what they earned.
//
// Two changes are under test. `tip` lets anyone credit anyone, which is how a
// burner pays whoever submitted its withdrawal INTO the vault rather than to an
// address that names them. And `insertShieldNoteFor` now pays its submitter out
// of the payee's balance, at a cap the payee signs.
//
// The invariant that matters most here is the quiet one: the note that gets
// inserted must still be exactly one bucket. The fixed denominations are the
// anonymity set, and a fee taken out of the bucket instead of out of the
// remaining balance would turn every paid insertion into a fingerprint.

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { poseidonContract } from "circomlibjs";

const PAS = (n: string) => ethers.parseEther(n);
const BUCKET = PAS("1");
const MAX_FEE = PAS("0.05");
const FEE = PAS("0.03");

describe("the fee market, in the vault", () => {
  async function vaultWithNotes() {
    const [owner, payee, submitter, stranger] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("PorterVault")).deploy();
    await vault.setAuthorized(owner.address, true);
    await vault.credit(payee.address, { value: PAS("10") });

    const impl = await new ethers.ContractFactory(
      poseidonContract.generateABI(2),
      poseidonContract.createCode(2),
      owner
    ).deploy();
    const poseidon = await (
      await ethers.getContractFactory("PoseidonT3Adapter")
    ).deploy(await impl.getAddress());
    await vault.setShieldBuckets([BUCKET]);
    await vault.setShieldPoseidon(poseidon.target);
    return { vault, owner, payee, submitter, stranger };
  }

  async function signInsertion(
    vault: { target: unknown },
    payee: { address: string; signTypedData: Function },
    commitment: bigint,
    maxFee: bigint,
    deadline: bigint,
    nonce = 0n
  ) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return payee.signTypedData(
      {
        name: "PorterVault",
        version: "1",
        chainId,
        verifyingContract: vault.target as string,
      },
      {
        ShieldNoteV2: [
          { name: "account", type: "address" },
          { name: "bucket", type: "uint96" },
          { name: "commitment", type: "uint256" },
          { name: "maxFee", type: "uint96" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      { account: payee.address, bucket: BUCKET, commitment, maxFee, nonce, deadline }
    );
  }

  const soon = () => BigInt(Math.floor(Date.now() / 1000) + 3600);

  describe("tip", () => {
    it("lets anyone pay anyone, with no authorization at all", async () => {
      // The whole point: a burner is nobody, and it still has to be able to pay
      // the stranger who submitted its withdrawal.
      const { vault, stranger, submitter } = await loadFixture(vaultWithNotes);
      await expect(
        vault.connect(stranger).tip(submitter.address, { value: FEE })
      ).to.not.be.reverted;
      expect(await vault.balanceOf(submitter.address)).to.equal(FEE);
    });

    it("credits rather than transfers, so the fee can still be shielded", async () => {
      // A fee that lands at an address is a fee anyone can read. A fee that
      // lands in the vault leaves through insertShieldNote like everything else.
      const { vault, stranger, submitter } = await loadFixture(vaultWithNotes);
      await vault.connect(stranger).tip(submitter.address, { value: BUCKET });
      await expect(
        vault.connect(submitter).insertShieldNote(BUCKET, 4242n)
      ).to.not.be.reverted;
      expect(await vault.balanceOf(submitter.address)).to.equal(0n);
    });

    it("credits exactly what it receives, so the books still balance", async () => {
      const { vault, stranger, submitter } = await loadFixture(vaultWithNotes);
      const before = await ethers.provider.getBalance(vault.target);
      await vault.connect(stranger).tip(submitter.address, { value: FEE });
      expect(await ethers.provider.getBalance(vault.target)).to.equal(before + FEE);
      expect(await vault.balanceOf(submitter.address)).to.equal(FEE);
    });

    it("refuses a zero payee and a zero value", async () => {
      const { vault, stranger, submitter } = await loadFixture(vaultWithNotes);
      await expect(
        vault.connect(stranger).tip(ethers.ZeroAddress, { value: FEE })
      ).to.be.revertedWith("zero-addr");
      await expect(
        vault.connect(stranger).tip(submitter.address, { value: 0 })
      ).to.be.revertedWith("zero-value");
    });

    it("is not a way into the authorized-only credit path", async () => {
      // `credit` asserts an escrow moved and stays permissioned; `tip` asserts
      // nothing. If tipping ever started counting as a protocol credit, the
      // escrow accounting would be writable by anyone.
      const { vault, stranger } = await loadFixture(vaultWithNotes);
      await expect(
        vault.connect(stranger).credit(stranger.address, { value: FEE })
      ).to.be.revertedWith("not-authorized");
    });
  });

  describe("paying the submitter of a note insertion", () => {
    it("inserts a note of exactly one bucket and pays the fee from what's left", async () => {
      // THE ANONYMITY-SET INVARIANT. If the fee came out of the bucket, the
      // note would be 0.97 PAS and would identify its owner across the pool for
      // as long as the pool exists.
      const { vault, payee, submitter } = await loadFixture(vaultWithNotes);
      const deadline = soon();
      const sig = await signInsertion(vault, payee, 777n, MAX_FEE, deadline);
      await vault
        .connect(submitter)
        .insertShieldNoteFor(payee.address, BUCKET, 777n, MAX_FEE, FEE, deadline, sig);

      expect(await vault.balanceOf(payee.address)).to.equal(PAS("10") - BUCKET - FEE);
      expect(await vault.balanceOf(submitter.address)).to.equal(FEE);
      expect(await vault.nextNoteIndex()).to.equal(1);
    });

    it("refuses a fee over the cap the payee signed", async () => {
      const { vault, payee, submitter } = await loadFixture(vaultWithNotes);
      const deadline = soon();
      const sig = await signInsertion(vault, payee, 777n, MAX_FEE, deadline);
      await expect(
        vault
          .connect(submitter)
          .insertShieldNoteFor(payee.address, BUCKET, 777n, MAX_FEE, MAX_FEE + 1n, deadline, sig)
      ).to.be.revertedWith("fee-over-cap");
    });

    it("refuses a cap the payee did not sign", async () => {
      // Otherwise the cap would be advisory: a submitter could pass whatever
      // maxFee suited it and claim up to that.
      const { vault, payee, submitter } = await loadFixture(vaultWithNotes);
      const deadline = soon();
      const sig = await signInsertion(vault, payee, 777n, MAX_FEE, deadline);
      await expect(
        vault
          .connect(submitter)
          .insertShieldNoteFor(payee.address, BUCKET, 777n, MAX_FEE * 10n, FEE, deadline, sig)
      ).to.be.revertedWith("bad-sig");
    });

    it("still works with no fee at all, so the free path is not lost", async () => {
      const { vault, payee, submitter } = await loadFixture(vaultWithNotes);
      const deadline = soon();
      const sig = await signInsertion(vault, payee, 777n, 0n, deadline);
      await vault
        .connect(submitter)
        .insertShieldNoteFor(payee.address, BUCKET, 777n, 0n, 0n, deadline, sig);
      expect(await vault.balanceOf(payee.address)).to.equal(PAS("10") - BUCKET);
      expect(await vault.balanceOf(submitter.address)).to.equal(0n);
    });

    it("fails when the balance cannot cover the bucket AND the fee", async () => {
      // It must fail here rather than cutting the note and leaving the payee
      // owing a fee they agreed to.
      const { vault, owner, submitter } = await loadFixture(vaultWithNotes);
      const [, , , , poor] = await ethers.getSigners();
      await vault.credit(poor.address, { value: BUCKET }); // exactly one bucket
      const deadline = soon();
      const sig = await signInsertion(vault, poor, 777n, MAX_FEE, deadline);
      await expect(
        vault
          .connect(submitter)
          .insertShieldNoteFor(poor.address, BUCKET, 777n, MAX_FEE, FEE, deadline, sig)
      ).to.be.revertedWith("insufficient-balance");
      expect(await vault.balanceOf(poor.address)).to.equal(BUCKET);
      expect(owner).to.exist;
    });

    it("cannot be replayed, because the nonce moves", async () => {
      const { vault, payee, submitter } = await loadFixture(vaultWithNotes);
      const deadline = soon();
      const sig = await signInsertion(vault, payee, 777n, MAX_FEE, deadline);
      await vault
        .connect(submitter)
        .insertShieldNoteFor(payee.address, BUCKET, 777n, MAX_FEE, FEE, deadline, sig);
      await expect(
        vault
          .connect(submitter)
          .insertShieldNoteFor(payee.address, BUCKET, 777n, MAX_FEE, FEE, deadline, sig)
      ).to.be.revertedWith("bad-sig");
    });

    it("pays the submitter that actually sent it, not one named in the signature", async () => {
      // The payee signs a cap, not a counterparty. Whoever does the work is
      // paid, which is what makes this a market rather than an appointment.
      const { vault, payee, stranger } = await loadFixture(vaultWithNotes);
      const deadline = soon();
      const sig = await signInsertion(vault, payee, 777n, MAX_FEE, deadline);
      await vault
        .connect(stranger)
        .insertShieldNoteFor(payee.address, BUCKET, 777n, MAX_FEE, FEE, deadline, sig);
      expect(await vault.balanceOf(stranger.address)).to.equal(FEE);
    });
  });
});
