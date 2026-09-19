import { expect } from "chai";
import { ethers } from "hardhat";

// Personhood gate (docs/PLAN.md §3.4). It ships off, because the project's own
// test account has no personhood yet and neither will most early testers.
// Governance turns it on by pointing it at an adapter over Asset Hub's
// personhood precompile; here a settable mock stands in for that adapter.

describe("personhood gate", () => {
  async function deploy() {
    const [owner, person, nobody] = await ethers.getSigners();
    const pause = await (await ethers.getContractFactory("PorterPauseRegistry")).deploy();
    const drivers = await (await ethers.getContractFactory("PorterDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("PorterVenues")).deploy(pause.target);
    const gate = await (await ethers.getContractFactory("MockPersonhood")).deploy();
    await gate.set(person.address, true);
    return { owner, person, nobody, drivers, venues, gate };
  }
  const register = (venues: any, who: any) =>
    venues.connect(who).registerVenue(37_774_900, -122_419_400, ethers.ZeroAddress, ethers.ZeroAddress, "ipfs://v");

  it("is off by default: anyone registers", async () => {
    const { nobody, drivers, venues } = await deploy();
    expect(await drivers.personhood()).to.equal(ethers.ZeroAddress);
    await drivers.connect(nobody).register("ipfs://d");
    await register(venues, nobody);
  });

  it("once on, only people register as drivers or venues, by either entry point", async () => {
    const { person, nobody, drivers, venues, gate } = await deploy();
    await expect(drivers.setPersonhood(gate.target)).to.emit(drivers, "PersonhoodSet").withArgs(gate.target);
    await venues.setPersonhood(gate.target);

    await expect(drivers.connect(nobody).register("ipfs://d")).to.be.revertedWith("not-a-person");
    await expect(drivers.connect(nobody).registerWithSessionKey("ipfs://d", ethers.Wallet.createRandom().address))
      .to.be.revertedWith("not-a-person");
    await expect(register(venues, nobody)).to.be.revertedWith("not-a-person");

    await drivers.connect(person).register("ipfs://d");
    await register(venues, person);
  });

  it("turning it off again reopens registration; existing drivers are never re-checked", async () => {
    const { person, nobody, drivers, gate } = await deploy();
    await drivers.setPersonhood(gate.target);
    await drivers.connect(person).register("ipfs://d");
    await gate.set(person.address, false);
    expect(await drivers.isEligible(person.address)).to.equal(true);
    await drivers.setPersonhood(ethers.ZeroAddress);
    await drivers.connect(nobody).register("ipfs://d");
  });
});
